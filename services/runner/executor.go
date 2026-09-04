package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type jobSpec struct {
	ID             string            `json:"id"`
	ProjectID      string            `json:"projectId"`
	Command        string            `json:"command"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	MemoryMb       int               `json:"memoryMb"`
	Network        string            `json:"network"`
	Env            map[string]string `json:"env,omitempty"`
	Files          map[string]string `json:"files,omitempty"`
	ArtifactGlobs  []string          `json:"artifactGlobs,omitempty"`
}
type runnerArtifact struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentHash string `json:"contentHash"`
	Content     string `json:"content"`
}
type jobState struct {
	Spec      jobSpec
	Status    string             `json:"status"`
	RunnerID  string             `json:"runnerId"`
	Logs      []string           `json:"logs"`
	Artifacts []runnerArtifact   `json:"artifacts,omitempty"`
	Process   *exec.Cmd          `json:"-"`
	Cancel    context.CancelFunc `json:"-"`
}
type runnerService struct {
	mu       sync.Mutex
	jobs     map[string]*jobState
	runnerID string
	image    string
}

func (r *runnerService) authorized(req *http.Request) bool {
	expected := runnerAPIToken()
	if expected == "" && strings.EqualFold(strings.TrimSpace(os.Getenv("LINKOS_ENV")), "production") {
		return false
	}
	return expected == "" || strings.TrimSpace(req.Header.Get("X-Runner-Token")) == expected
}

func runnerAPIToken() string {
	if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_API_TOKEN")); token != "" {
		return token
	}
	return strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN"))
}

func newRunnerService() *runnerService {
	id := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_ID"))
	if id == "" {
		id = "runner-dev"
	}
	image := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_IMAGE"))
	if image == "" {
		image = "alpine:3.20"
	}
	return &runnerService{jobs: make(map[string]*jobState), runnerID: id, image: image}
}
func (r *runnerService) engine() (string, error) {
	for _, candidate := range []string{"docker", "podman"} {
		if _, err := exec.LookPath(candidate); err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := exec.CommandContext(ctx, candidate, "info").Run()
		cancel()
		if err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("no usable Docker or Podman engine")
}
func (r *runnerService) register(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	if !r.authorized(req) {
		writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner token is invalid")
		return
	}
	write(w, 201, map[string]interface{}{"runnerId": r.runnerID, "status": "registered", "platform": "container", "version": "0.1.0", "capabilities": []string{"docker", "podman", "network-deny", "resource-limits"}})
}
func (r *runnerService) createJob(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	if !r.authorized(req) {
		writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner token is invalid")
		return
	}
	var spec jobSpec
	if json.NewDecoder(io.LimitReader(req.Body, 64*1024)).Decode(&spec) != nil || strings.TrimSpace(spec.Command) == "" {
		writeError(w, 400, "INVALID_REQUEST", "command is required")
		return
	}
	if spec.TimeoutSeconds <= 0 || spec.TimeoutSeconds > 3600 {
		spec.TimeoutSeconds = 600
	}
	if spec.MemoryMb <= 0 || spec.MemoryMb > 16384 {
		spec.MemoryMb = 512
	}
	if spec.Network == "" {
		spec.Network = "deny"
	}
	if spec.Network != "deny" {
		writeError(w, 403, "JOB_POLICY_DENIED", "runner only permits network=deny until an allowlist is configured")
		return
	}
	engine, err := r.engine()
	if err != nil {
		writeError(w, 503, "RUNNER_UNAVAILABLE", err.Error())
		return
	}
	if spec.ID == "" {
		spec.ID = "job_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(spec.TimeoutSeconds)*time.Second)
	state := &jobState{Spec: spec, Status: "queued", RunnerID: r.runnerID, Logs: nil, Cancel: cancel}
	r.mu.Lock()
	r.jobs[spec.ID] = state
	r.mu.Unlock()
	go r.executeContainer(ctx, state, engine)
	body := map[string]interface{}{"id": spec.ID, "status": "queued", "runnerId": r.runnerID}
	write(w, 202, body)
}

func (r *runnerService) executeContainer(ctx context.Context, state *jobState, engine string) {
	r.mu.Lock()
	if state.Status == "canceled" {
		r.mu.Unlock()
		return
	}
	state.Status = "running"
	workspace, workspaceErr := materializeWorkspace(state.Spec.Files)
	if workspaceErr != nil {
		state.Status = "failed"
		state.Logs = append(state.Logs, redactRunner(workspaceErr.Error()))
		r.mu.Unlock()
		return
	}
	if workspace != "" {
		defer os.RemoveAll(workspace)
	}
	workdir := "/tmp"
	args := []string{"run", "--rm", "--network", "none", "--read-only", "--user", "65534:65534", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", fmt.Sprintf("%dm", state.Spec.MemoryMb), "--pids-limit", "256"}
	if workspace != "" {
		args = append(args, "--mount", "type=bind,src="+workspace+",dst=/workspace,readonly")
		workdir = "/workspace"
	}
	args = append(args, "--workdir", workdir, r.image, "sh", "-lc", state.Spec.Command)
	cmd := exec.CommandContext(ctx, engine, args...)
	for key, value := range state.Spec.Env {
		if safeEnvKey(key) {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	for _, key := range []string{"DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CONTAINER_HOST"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	state.Process = cmd
	r.mu.Unlock()
	output, runErr := cmd.CombinedOutput()
	artifacts := collectArtifacts(workspace, state.Spec.ArtifactGlobs)
	status := "succeeded"
	if ctx.Err() == context.DeadlineExceeded {
		status = "timed_out"
	} else if ctx.Err() == context.Canceled {
		status = "canceled"
	} else if runErr != nil {
		status = "failed"
	}
	r.mu.Lock()
	state.Status = status
	state.Artifacts = artifacts
	if text := redactRunner(string(output)); text != "" {
		state.Logs = append(state.Logs, text)
	}
	if runErr != nil && status == "failed" {
		state.Logs = append(state.Logs, redactRunner(runErr.Error()))
	}
	r.mu.Unlock()
}

func collectArtifacts(workspace string, globs []string) []runnerArtifact {
	if workspace == "" || len(globs) == 0 {
		return nil
	}
	const maxArtifactBytes = int64(8 * 1024 * 1024)
	const maxTotalBytes = int64(16 * 1024 * 1024)
	var result []runnerArtifact
	var total int64
	seen := make(map[string]struct{})
	for _, pattern := range globs {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" || filepath.IsAbs(pattern) || strings.Contains(pattern, ".."+string(os.PathSeparator)) {
			continue
		}
		matches, err := filepath.Glob(filepath.Join(workspace, filepath.Clean(pattern)))
		if err != nil {
			continue
		}
		for _, path := range matches {
			info, err := os.Stat(path)
			if err != nil || info.IsDir() || info.Size() > maxArtifactBytes || total+info.Size() > maxTotalBytes {
				continue
			}
			relative, err := filepath.Rel(workspace, path)
			if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
				continue
			}
			if _, exists := seen[relative]; exists {
				continue
			}
			content, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			hash := sha256.Sum256(content)
			result = append(result, runnerArtifact{Name: filepath.ToSlash(relative), Size: int64(len(content)), ContentHash: fmt.Sprintf("%x", hash[:]), Content: base64.RawStdEncoding.EncodeToString(content)})
			seen[relative] = struct{}{}
			total += int64(len(content))
		}
	}
	return result
}

func materializeWorkspace(files map[string]string) (string, error) {
	if len(files) == 0 {
		return "", nil
	}
	root, err := os.MkdirTemp("", "linkos-job-")
	if err != nil {
		return "", err
	}
	total := 0
	for name, content := range files {
		total += len(content)
		if total > 64*1024*1024 {
			_ = os.RemoveAll(root)
			return "", errors.New("workspace exceeds 64 MiB")
		}
		clean := filepath.Clean(name)
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
			_ = os.RemoveAll(root)
			return "", errors.New("workspace contains an invalid path")
		}
		target := filepath.Join(root, clean)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			_ = os.RemoveAll(root)
			return "", err
		}
		if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
			_ = os.RemoveAll(root)
			return "", err
		}
	}
	return root, nil
}
func safeEnvKey(key string) bool {
	if key == "" || strings.ContainsAny(key, "=\x00\r\n") {
		return false
	}
	upper := strings.ToUpper(key)
	for _, blocked := range []string{"TOKEN", "PASSWORD", "SECRET", "KEY"} {
		if strings.Contains(upper, blocked) {
			return false
		}
	}
	return true
}
func redactRunner(value string) string {
	lines := strings.Split(value, "\n")
	for i, line := range lines {
		upper := strings.ToUpper(line)
		if strings.Contains(upper, "TOKEN") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "SECRET") {
			lines[i] = "[redacted]"
		}
	}
	return strings.Join(lines, "\n")
}
func (r *runnerService) handleJob(w http.ResponseWriter, req *http.Request) {
	if !r.authorized(req) {
		writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner token is invalid")
		return
	}
	path := strings.Trim(strings.TrimPrefix(req.URL.Path, "/jobs/"), "/")
	parts := strings.Split(path, "/")
	id := parts[0]
	r.mu.Lock()
	state, ok := r.jobs[id]
	if ok {
		// Copy mutable fields while holding the service lock. Container execution
		// runs in a goroutine and HTTP polling must remain race-free.
		status, runnerID := state.Status, state.RunnerID
		logs := append([]string(nil), state.Logs...)
		artifacts := append([]runnerArtifact(nil), state.Artifacts...)
		state = &jobState{Status: status, RunnerID: runnerID, Logs: logs, Artifacts: artifacts, Cancel: state.Cancel}
	}
	r.mu.Unlock()
	if !ok {
		writeError(w, 404, "INVALID_REQUEST", "job not found")
		return
	}
	if len(parts) > 1 && parts[1] == "cancel" {
		if req.Method != http.MethodPost {
			writeError(w, 405, "INVALID_REQUEST", "method not allowed")
			return
		}
		if state.Cancel != nil {
			state.Cancel()
		}
		r.mu.Lock()
		if original, exists := r.jobs[id]; exists {
			original.Status = "canceled"
		}
		r.mu.Unlock()
		write(w, 200, map[string]string{"id": id, "status": "canceled"})
		return
	}
	if len(parts) > 1 && parts[1] == "logs" {
		write(w, 200, map[string]interface{}{"items": state.Logs, "nextCursor": ""})
		return
	}
	if len(parts) > 1 && parts[1] == "artifacts" {
		write(w, 200, map[string]interface{}{"items": state.Artifacts, "nextCursor": ""})
		return
	}
	write(w, 200, map[string]interface{}{"id": id, "status": state.Status, "runnerId": state.RunnerID})
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	traceID := fmt.Sprintf("tr_%x", time.Now().UTC().UnixNano())
	w.Header().Set("X-Trace-ID", traceID)
	write(w, status, map[string]string{"error": code, "message": message, "traceId": traceID})
}
