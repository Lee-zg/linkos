package main

import (
	"bytes"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

// mvpBlobBackend is intentionally optional so the existing memory backend
// remains a useful test double. Durable deployments use the SQLite blob while
// the upload/event tables keep their existing independent retention rules.
type mvpBlobBackend interface {
	loadMVPState() ([]byte, error)
	saveMVPState([]byte) error
}

type mvpState struct {
	Resources                map[string]protocol.ResourceRecord    `json:"resources"`
	Shares                   map[string]protocol.ResourceShareLink `json:"shares"`
	Channels                 map[string]protocol.ChatChannel       `json:"channels"`
	Messages                 map[string]protocol.ChatMessage       `json:"messages"`
	CodeFiles                map[string]protocol.CodeFile          `json:"codeFiles"`
	CodeData                 map[string]string                     `json:"codeData"`
	CodeVers                 map[string][]protocol.CodeVersion     `json:"codeVersions"`
	Jobs                     map[string]mvpJob                     `json:"jobs"`
	JobLogs                  map[string][]protocol.JobLogChunk     `json:"jobLogs"`
	Artifacts                map[string]protocol.JobArtifact       `json:"artifacts"`
	Runners                  map[string]protocol.RunnerInfo        `json:"runners"`
	RunnerRegistrationTokens map[string]runnerRegistrationToken    `json:"runnerRegistrationTokens"`
	RunnerCredentials        map[string]runnerCredential           `json:"runnerCredentials"`
	RunnerBootstrapTokens    map[string]string                     `json:"runnerBootstrapTokens"`
	Plugins                  map[string]protocol.PluginRecord      `json:"plugins"`
	NextSeq                  int64                                 `json:"nextSeq"`
}

type runnerRegistrationToken struct {
	ExpiresAt string `json:"expiresAt"`
	UsedAt    string `json:"usedAt,omitempty"`
	CreatedBy string `json:"createdBy"`
}

type runnerCredential struct {
	Digest    string `json:"digest"`
	Version   int    `json:"version"`
	RevokedAt string `json:"revokedAt,omitempty"`
}

type mvpJob struct {
	Ref       protocol.JobRef  `json:"ref"`
	Spec      protocol.JobSpec `json:"spec"`
	CreatedAt string           `json:"createdAt"`
	UpdatedAt string           `json:"updatedAt"`
	Cancel    bool             `json:"cancel"`
}

type mvpStore struct {
	mu              sync.RWMutex
	backend         persistBackend
	hub             *hub
	audit           *auditStore
	contentDownload http.HandlerFunc
	content         *contentStore
	state           mvpState
}

func (s *mvpStore) recordMutation(r *http.Request, principal authPrincipal, action, target, detail string) {
	if s.audit == nil {
		return
	}
	s.audit.record(auditEntry{ActorUserID: principal.UserID, ActorName: principal.DisplayName, Action: action, Target: target, Detail: redactSecrets(detail), RemoteAddr: r.RemoteAddr})
}

func newMVPStore(backend persistBackend, h *hub) *mvpStore {
	s := &mvpStore{backend: backend, hub: h, state: newMVPState()}
	if durable, ok := backend.(mvpBlobBackend); ok {
		if raw, err := durable.loadMVPState(); err == nil && len(raw) > 0 {
			if err := json.Unmarshal(raw, &s.state); err != nil {
				log.Printf("load mvp state: %v", err)
			}
		}
	}
	normalizeMVPState(&s.state)
	s.ensureSeedData()
	s.rebuildMessageIndex()
	return s
}

func normalizeMVPState(state *mvpState) {
	if state.Resources == nil {
		state.Resources = make(map[string]protocol.ResourceRecord)
	}
	if state.Shares == nil {
		state.Shares = make(map[string]protocol.ResourceShareLink)
	}
	if state.Channels == nil {
		state.Channels = make(map[string]protocol.ChatChannel)
	}
	if state.Messages == nil {
		state.Messages = make(map[string]protocol.ChatMessage)
	}
	if state.CodeFiles == nil {
		state.CodeFiles = make(map[string]protocol.CodeFile)
	}
	if state.CodeData == nil {
		state.CodeData = make(map[string]string)
	}
	if state.CodeVers == nil {
		state.CodeVers = make(map[string][]protocol.CodeVersion)
	}
	if state.Jobs == nil {
		state.Jobs = make(map[string]mvpJob)
	}
	if state.JobLogs == nil {
		state.JobLogs = make(map[string][]protocol.JobLogChunk)
	}
	if state.Artifacts == nil {
		state.Artifacts = make(map[string]protocol.JobArtifact)
	}
	if state.Runners == nil {
		state.Runners = make(map[string]protocol.RunnerInfo)
	}
	if state.RunnerRegistrationTokens == nil {
		state.RunnerRegistrationTokens = make(map[string]runnerRegistrationToken)
	}
	if state.RunnerCredentials == nil {
		state.RunnerCredentials = make(map[string]runnerCredential)
	}
	if state.RunnerBootstrapTokens == nil {
		state.RunnerBootstrapTokens = make(map[string]string)
	}
	if state.Plugins == nil {
		state.Plugins = make(map[string]protocol.PluginRecord)
	}
}

func (s *mvpStore) rebuildMessageIndex() {
	durable, ok := s.backend.(mvpFTSBackend)
	if !ok {
		return
	}
	s.mu.RLock()
	messages := make([]protocol.ChatMessage, 0, len(s.state.Messages))
	for _, message := range s.state.Messages {
		messages = append(messages, message)
	}
	s.mu.RUnlock()
	for _, message := range messages {
		if err := durable.indexMVPMessage(message); err != nil {
			log.Printf("index message %s: %v", message.ID, err)
		}
	}
}

func newMVPState() mvpState {
	return mvpState{
		Resources:                make(map[string]protocol.ResourceRecord),
		Shares:                   make(map[string]protocol.ResourceShareLink),
		Channels:                 make(map[string]protocol.ChatChannel),
		Messages:                 make(map[string]protocol.ChatMessage),
		CodeFiles:                make(map[string]protocol.CodeFile),
		CodeData:                 make(map[string]string),
		CodeVers:                 make(map[string][]protocol.CodeVersion),
		Jobs:                     make(map[string]mvpJob),
		JobLogs:                  make(map[string][]protocol.JobLogChunk),
		Artifacts:                make(map[string]protocol.JobArtifact),
		Runners:                  make(map[string]protocol.RunnerInfo),
		RunnerRegistrationTokens: make(map[string]runnerRegistrationToken),
		RunnerCredentials:        make(map[string]runnerCredential),
		RunnerBootstrapTokens:    make(map[string]string),
		Plugins:                  make(map[string]protocol.PluginRecord),
	}
}

func (s *mvpStore) ensureSeedData() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.state.Channels) == 0 {
		for _, name := range []string{"engineering", "release", "design", "notes"} {
			s.state.Channels[name] = protocol.ChatChannel{
				ID: name, WorkspaceID: "demo", Name: name, Kind: "channel", MemberIDs: []string{}, CreatedAt: time.Now().UTC().Format(time.RFC3339),
			}
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, exists := s.state.Resources["project_gateway"]; !exists {
		s.state.Resources["project_gateway"] = protocol.ResourceRecord{ID: "project_gateway", WorkspaceID: "demo", Type: "code.project", Name: "api-gateway", OwnerID: "system", Meta: map[string]interface{}{"files": len(s.state.CodeFiles)}, CreatedAt: now, UpdatedAt: now}
	}
	for id, channel := range s.state.Channels {
		if _, exists := s.state.Resources[id]; !exists {
			s.state.Resources[id] = protocol.ResourceRecord{ID: id, WorkspaceID: "demo", Type: "chat.channel", Name: channel.Name, OwnerID: "system", CreatedAt: channel.CreatedAt, UpdatedAt: channel.CreatedAt}
		}
	}
	if len(s.state.CodeFiles) == 0 {
		content := "package gateway\n\nimport (\n  \"context\"\n  \"log\"\n  \"net/http\"\n)\n\nfunc (h *Hub) Broadcast(ctx context.Context, event Event) error {\n  if err := h.store.Append(ctx, event); err != nil {\n    return err\n  }\n  for client := range h.clients {\n    client.Send(event)\n  }\n  return nil\n}\n"
		hash := sha256.Sum256([]byte(content))
		file := protocol.CodeFile{ID: "code_file_websocket", ProjectID: "project_gateway", Path: "internal/websocket.go", Language: "go", Size: int64(len(content)), ContentHash: hex.EncodeToString(hash[:]), Version: "v1", UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
		s.state.CodeFiles[file.ID] = file
		s.state.CodeData[file.ID] = content
		s.state.CodeVers[file.ID] = []protocol.CodeVersion{{ID: "codever_1", FileID: file.ID, Version: "v1", ContentHash: file.ContentHash, Content: content, CreatedBy: "system", CreatedAt: file.UpdatedAt}}
		s.state.Resources[file.ID] = protocol.ResourceRecord{ID: file.ID, WorkspaceID: "demo", Type: "code.file", Name: file.Path, ParentID: file.ProjectID, OwnerID: "system", Meta: map[string]interface{}{"projectId": file.ProjectID, "version": file.Version, "size": file.Size}, CreatedAt: file.UpdatedAt, UpdatedAt: file.UpdatedAt}
	}
	for id, file := range s.state.CodeFiles {
		if _, exists := s.state.Resources[id]; !exists {
			s.state.Resources[id] = protocol.ResourceRecord{ID: id, WorkspaceID: "demo", Type: "code.file", Name: file.Path, ParentID: file.ProjectID, OwnerID: "system", Meta: map[string]interface{}{"projectId": file.ProjectID, "version": file.Version, "size": file.Size}, CreatedAt: file.UpdatedAt, UpdatedAt: file.UpdatedAt}
		}
	}
	if project, exists := s.state.Resources["project_gateway"]; exists {
		if project.Meta == nil {
			project.Meta = map[string]interface{}{}
		}
		project.Meta["files"] = len(s.state.CodeFiles)
		project.UpdatedAt = now
		s.state.Resources["project_gateway"] = project
	}
	if len(s.state.Runners) == 0 {
		now := time.Now().UTC().Format(time.RFC3339)
		s.state.Runners["runner-dev"] = protocol.RunnerInfo{ID: "runner-dev", WorkspaceID: "demo", Platform: "container", Version: "0.1.0", Capabilities: []string{"go/1.23", "node/22"}, Labels: map[string]string{"pool": "default"}, Status: "offline", LastSeenAt: now}
	}
	if len(s.state.Plugins) == 0 {
		for _, p := range []struct{ id, name string }{{"files.core", "文件"}, {"chat.core", "聊天"}, {"code.workbench", "代码工作台"}, {"runner.exec", "运行任务"}} {
			manifest := protocol.PluginManifest{ID: p.id, Name: p.name, Version: "0.1.0", APIVersion: "1.0", Entry: mapEntry(p.id), Permissions: []string{"resource.read"}, Contributes: mapContributes(p.id), Network: map[string]interface{}{"mode": "deny"}}
			s.state.Plugins[p.id] = protocol.PluginRecord{ID: p.id, Name: p.name, Version: "0.1.0", APIVersion: "1.0", Status: "enabled", Manifest: manifest, Permissions: manifest.Permissions, Health: "healthy", InstalledAt: time.Now().UTC().Format(time.RFC3339)}
		}
	}
	s.loadPluginManifestsLocked()
	s.persistLocked()
}

func pluginTrustedKeys() []ed25519.PublicKey {
	var keys []ed25519.PublicKey
	for _, raw := range strings.Split(os.Getenv("LINKOS_PLUGIN_TRUSTED_KEYS"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		decoded, err := base64.RawStdEncoding.DecodeString(raw)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			if hexKey, hexErr := hex.DecodeString(raw); hexErr == nil && len(hexKey) == ed25519.PublicKeySize {
				decoded = hexKey
			} else {
				continue
			}
		}
		keys = append(keys, ed25519.PublicKey(decoded))
	}
	return keys
}

func pluginSignaturesRequired() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("LINKOS_ENV")), "production")
}

func verifyPluginSignature(manifest protocol.PluginManifest, signature string, keys []ed25519.PublicKey) bool {
	if len(keys) == 0 {
		return signature == ""
	}
	sig, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil {
		if decoded, hexErr := hex.DecodeString(strings.TrimSpace(signature)); hexErr == nil {
			sig = decoded
		} else {
			return false
		}
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		return false
	}
	for _, key := range keys {
		if len(key) == ed25519.PublicKeySize && ed25519.Verify(key, payload, sig) {
			return true
		}
	}
	return false
}

func validatePluginManifest(manifest protocol.PluginManifest) []string {
	errorsList := []string{}
	if manifest.ID == "" || !isPluginID(manifest.ID) {
		errorsList = append(errorsList, "id must be a lowercase plugin identifier")
	}
	if manifest.Name == "" {
		errorsList = append(errorsList, "name is required")
	}
	if manifest.Version == "" {
		errorsList = append(errorsList, "version is required")
	}
	if manifest.APIVersion == "" {
		errorsList = append(errorsList, "apiVersion is required")
	}
	if len(manifest.Entry) == 0 {
		errorsList = append(errorsList, "at least one entry is required")
	}
	return errorsList
}

func isPluginID(id string) bool {
	if id == "" {
		return false
	}
	for i, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '.' {
			if i == 0 && (r == '-' || r == '.') {
				return false
			}
			continue
		}
		return false
	}
	return true
}

func (s *mvpStore) loadPluginManifestsLocked() {
	root := strings.TrimSpace(os.Getenv("LINKOS_PLUGIN_DIR"))
	if root == "" {
		root = filepath.Join("..", "..", "plugins")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	keys := pluginTrustedKeys()
	if pluginSignaturesRequired() && len(keys) == 0 {
		log.Printf("plugin directory disabled: LINKOS_PLUGIN_TRUSTED_KEYS is required in production")
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(root, entry.Name(), "manifest.json")
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			continue
		}
		var manifest protocol.PluginManifest
		if json.Unmarshal(raw, &manifest) != nil || len(validatePluginManifest(manifest)) > 0 {
			continue
		}
		signature := ""
		if sigRaw, sigErr := os.ReadFile(manifestPath + ".sig"); sigErr == nil {
			signature = strings.TrimSpace(string(sigRaw))
		}
		if (len(keys) > 0 || pluginSignaturesRequired()) && !verifyPluginSignature(manifest, signature, keys) {
			continue
		}
		if current, exists := s.state.Plugins[manifest.ID]; exists {
			current.Manifest, current.Name, current.Version, current.APIVersion, current.Signature = manifest, manifest.Name, manifest.Version, manifest.APIVersion, signature
			current.Permissions, current.Health = manifest.Permissions, "healthy"
			s.state.Plugins[manifest.ID] = current
			continue
		}
		s.state.Plugins[manifest.ID] = protocol.PluginRecord{ID: manifest.ID, Name: manifest.Name, Version: manifest.Version, APIVersion: manifest.APIVersion, Status: "installed", Manifest: manifest, Signature: signature, Permissions: manifest.Permissions, Health: "healthy", InstalledAt: time.Now().UTC().Format(time.RFC3339)}
	}
}

func mapEntry(id string) map[string]string {
	entry := map[string]string{"ui": "ui/index.js", "service": "service/index.js"}
	if id == "runner.exec" {
		entry["runner"] = "runner/index.js"
	}
	return entry
}

func mapContributes(id string) map[string][]string {
	contrib := map[string][]string{}
	switch id {
	case "files.core":
		contrib["routes"], contrib["commands"], contrib["resourceTypes"] = []string{"/files"}, []string{"file.open", "file.upload"}, []string{"file"}
	case "chat.core":
		contrib["routes"], contrib["commands"], contrib["resourceTypes"] = []string{"/chat"}, []string{"chat.send", "chat.search"}, []string{"chat.channel", "chat.message"}
	case "code.workbench":
		contrib["routes"], contrib["commands"], contrib["resourceTypes"] = []string{"/code", "/code/:resourceId"}, []string{"code.open", "code.save", "code.run"}, []string{"code.project", "code.file"}
	case "runner.exec":
		contrib["routes"], contrib["commands"], contrib["resourceTypes"] = []string{"/tasks"}, []string{"job.submit", "job.cancel"}, []string{"job"}
	}
	return contrib
}

func (s *mvpStore) persistLocked() {
	durable, ok := s.backend.(mvpBlobBackend)
	if !ok {
		return
	}
	raw, err := json.Marshal(s.state)
	if err != nil {
		log.Printf("marshal mvp state: %v", err)
		return
	}
	if err := durable.saveMVPState(raw); err != nil {
		log.Printf("persist mvp state: %v", err)
	}
}

func (s *mvpStore) listChannels() []protocol.ChatChannel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]protocol.ChatChannel, 0, len(s.state.Channels))
	for _, item := range s.state.Channels {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

func channelAllows(principal authPrincipal, channel protocol.ChatChannel) bool {
	if channel.Kind != "direct" || len(channel.MemberIDs) == 0 || principal.Role == roleAdmin || principal.Role == "owner" {
		return true
	}
	for _, memberID := range channel.MemberIDs {
		if memberID == principal.UserID {
			return true
		}
	}
	return false
}

func (s *mvpStore) listChannelsFor(principal authPrincipal) []protocol.ChatChannel {
	items := s.listChannels()
	filtered := items[:0]
	for _, channel := range items {
		if channelAllows(principal, channel) {
			filtered = append(filtered, channel)
		}
	}
	return filtered
}

func (s *mvpStore) listMessages(channelID, query, cursor string, limit int) (items []protocol.ChatMessage, next string) {
	return s.listMessagesFiltered(channelID, "", query, "", "", cursor, limit)
}

func (s *mvpStore) listMessagesFiltered(channelID, authorID, query, from, to, cursor string, limit int) (items []protocol.ChatMessage, next string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit < 1 || limit > 200 {
		limit = 50
	}
	var ftsIDs map[string]struct{}
	if query != "" {
		if durable, ok := s.backend.(mvpFTSBackend); ok {
			if ids, err := durable.searchMVPMessage(query); err == nil {
				ftsIDs = make(map[string]struct{}, len(ids))
				for _, id := range ids {
					ftsIDs[id] = struct{}{}
				}
			}
		}
	}
	for _, msg := range s.state.Messages {
		if channelID != "" && msg.ChannelID != channelID {
			continue
		}
		if authorID != "" && msg.AuthorID != authorID {
			continue
		}
		if from != "" && msg.CreatedAt < from {
			continue
		}
		if to != "" && msg.CreatedAt > to {
			continue
		}
		if query != "" {
			if ftsIDs != nil {
				if _, ok := ftsIDs[msg.ID]; !ok {
					continue
				}
			} else if !strings.Contains(strings.ToLower(msg.Body), strings.ToLower(query)) {
				continue
			}
		}
		if msg.DeletedAt != "" {
			continue
		}
		items = append(items, msg)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt < items[j].CreatedAt
	})
	start := 0
	if cursor != "" {
		if n, err := strconv.Atoi(cursor); err == nil && n >= 0 {
			start = n
		}
	}
	if start >= len(items) {
		return []protocol.ChatMessage{}, ""
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	if end < len(items) {
		next = strconv.Itoa(end)
	}
	return items[start:end], next
}

func (s *mvpStore) addMessage(message protocol.ChatMessage) {
	s.mu.Lock()
	s.state.Messages[message.ID] = message
	s.persistLocked()
	s.mu.Unlock()
	if durable, ok := s.backend.(mvpFTSBackend); ok {
		if err := durable.indexMVPMessage(message); err != nil {
			log.Printf("index message %s: %v", message.ID, err)
		}
	}
}

func (s *mvpStore) updateMessage(id string, update func(*protocol.ChatMessage)) (protocol.ChatMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	message, ok := s.state.Messages[id]
	if !ok {
		return protocol.ChatMessage{}, false
	}
	update(&message)
	message.Version++
	s.state.Messages[id] = message
	s.persistLocked()
	updated := message
	if durable, ok := s.backend.(mvpFTSBackend); ok {
		if err := durable.indexMVPMessage(updated); err != nil {
			log.Printf("index message %s: %v", id, err)
		}
	}
	return message, true
}

func (s *mvpStore) codeFile(id string) (protocol.CodeFile, string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, ok := s.state.CodeFiles[id]
	return file, s.state.CodeData[id], ok
}

func (s *mvpStore) saveCode(id, content, baseVersion, actor, message string, force bool) (protocol.CodeVersion, *protocol.CodeConflict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, ok := s.state.CodeFiles[id]
	if !ok {
		return protocol.CodeVersion{}, nil, os.ErrNotExist
	}
	current := s.state.CodeVers[id][len(s.state.CodeVers[id])-1]
	if !force && baseVersion != current.Version {
		return protocol.CodeVersion{}, &protocol.CodeConflict{Error: "RESOURCE_VERSION_MISMATCH", Current: current, BaseVersion: baseVersion, Diff: simpleDiff(current.Content, content)}, nil
	}
	hash := sha256.Sum256([]byte(content))
	version := fmt.Sprintf("v%d", len(s.state.CodeVers[id])+1)
	next := protocol.CodeVersion{ID: "codever_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10), FileID: id, Version: version, ContentHash: hex.EncodeToString(hash[:]), Content: content, CreatedBy: actor, CreatedAt: time.Now().UTC().Format(time.RFC3339), DiffSummary: diffSummary(current.Content, content)}
	s.state.CodeVers[id] = append(s.state.CodeVers[id], next)
	s.state.CodeData[id] = content
	file.Size, file.ContentHash, file.Version, file.UpdatedAt = int64(len(content)), next.ContentHash, version, next.CreatedAt
	s.state.CodeFiles[id] = file
	s.persistLocked()
	return next, nil, nil
}

func simpleDiff(oldContent, newContent string) string {
	if oldContent == newContent {
		return ""
	}
	return fmt.Sprintf("@@ -1 +1 @@\n-%s\n+%s", firstLine(oldContent), firstLine(newContent))
}

func firstLine(value string) string {
	if i := strings.IndexByte(value, '\n'); i >= 0 {
		return value[:i]
	}
	return value
}

func diffSummary(oldContent, newContent string) map[string]int {
	oldLines, newLines := strings.Count(oldContent, "\n"), strings.Count(newContent, "\n")
	return map[string]int{"added": maxInt(0, newLines-oldLines), "removed": maxInt(0, oldLines-newLines)}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (s *mvpStore) createJob(spec protocol.JobSpec, actor string) protocol.JobRef {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.NextSeq++
	id := fmt.Sprintf("job_%d", s.state.NextSeq)
	now := time.Now().UTC().Format(time.RFC3339)
	runnerID := ""
	for _, runner := range s.state.Runners {
		if runner.Status == "online" {
			runnerID = runner.ID
			break
		}
	}
	ref := protocol.JobRef{ID: id, Status: "queued", RunnerID: runnerID, CreatedAt: now}
	s.state.Jobs[id] = mvpJob{Ref: ref, Spec: spec, CreatedAt: now, UpdatedAt: now}
	s.persistLocked()
	return ref
}

func (s *mvpStore) getJob(id string) (mvpJob, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.state.Jobs[id]
	return job, ok
}

func (s *mvpStore) setJobStatus(id string, status protocol.JobStatus) (protocol.JobRef, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.state.Jobs[id]
	if !ok {
		return protocol.JobRef{}, false
	}
	job.Ref.Status, job.UpdatedAt = status, time.Now().UTC().Format(time.RFC3339)
	if status == "running" {
		job.Ref.StartedAt = job.UpdatedAt
	}
	if status == "succeeded" || status == "failed" || status == "canceled" || status == "timed_out" {
		job.Ref.EndedAt = job.UpdatedAt
	}
	s.state.Jobs[id] = job
	s.persistLocked()
	return job.Ref, true
}

func (s *mvpStore) appendLog(id string, level string, chunk string) protocol.JobLogChunk {
	s.mu.Lock()
	defer s.mu.Unlock()
	item := protocol.JobLogChunk{JobID: id, Seq: len(s.state.JobLogs[id]) + 1, Level: level, Chunk: redactSecrets(chunk), At: time.Now().UTC().Format(time.RFC3339)}
	s.state.JobLogs[id] = append(s.state.JobLogs[id], item)
	s.persistLocked()
	return item
}

func redactSecrets(value string) string {
	for _, key := range []string{"TOKEN", "PASSWORD", "SECRET", "API_KEY"} {
		lines := strings.Split(value, "\n")
		for i, line := range lines {
			if strings.Contains(strings.ToUpper(line), key) {
				lines[i] = "[redacted]"
			}
		}
		value = strings.Join(lines, "\n")
	}
	return value
}

func (s *mvpStore) listPlugins() []protocol.PluginRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]protocol.PluginRecord, 0, len(s.state.Plugins))
	for _, item := range s.state.Plugins {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

func (s *mvpStore) setPluginStatus(id string, status protocol.PluginStatus) (protocol.PluginRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.state.Plugins[id]
	if !ok {
		return protocol.PluginRecord{}, false
	}
	if status == "disabled" || status == "enabled" || status == "installed" {
		item.Status = string(status)
		item.Health = "healthy"
	} else if status == "uninstalled" {
		item.Status = string(status)
		item.Health = "failed"
	} else if status == "failed" {
		if item.Previous != nil {
			previous := item.Previous
			item.Manifest = previous.Manifest
			item.Signature = previous.Signature
			item.Name = previous.Manifest.Name
			item.Version = previous.Manifest.Version
			item.APIVersion = previous.Manifest.APIVersion
			item.Permissions = previous.Manifest.Permissions
			item.Status = previous.Status
			item.Health = "degraded"
			item.Previous = nil
		} else {
			item.Status = string(status)
			item.Health = "failed"
		}
	}
	if status == "rollback" && item.Previous != nil {
		previous := item.Previous
		item.Manifest = previous.Manifest
		item.Signature = previous.Signature
		item.Name = previous.Manifest.Name
		item.Version = previous.Manifest.Version
		item.APIVersion = previous.Manifest.APIVersion
		item.Permissions = previous.Manifest.Permissions
		item.Status = previous.Status
		item.Previous = nil
	} else if status == "rollback" {
		item.Status = "disabled"
		item.Health = "healthy"
	}
	s.state.Plugins[id] = item
	s.persistLocked()
	return item, true
}

func (s *mvpStore) listRunners() []protocol.RunnerInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]protocol.RunnerInfo, 0, len(s.state.Runners))
	for _, item := range s.state.Runners {
		if item.Status == "online" {
			if seen, err := time.Parse(time.RFC3339, item.LastSeenAt); err == nil && time.Since(seen) > 90*time.Second {
				item.Status = "offline"
			}
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

func principalForRequest(auth *authStore, r *http.Request) (authPrincipal, bool) {
	if auth == nil {
		return authPrincipal{UserID: "usr_test", DisplayName: "成员", Role: roleMember, WorkspaceID: "demo", Status: accessStatusActive}, true
	}
	return auth.authenticateRequest(r, "demo")
}

func registerMVPRoutes(mux *http.ServeMux, auth *authStore, store *mvpStore) {
	active := func(handler http.HandlerFunc) http.HandlerFunc { return requireActive(auth, "demo", handler) }
	mux.HandleFunc("/api/v1/resources", active(store.handleResources))
	mux.HandleFunc("/api/v1/resources/", active(store.handleResourceItem))
	mux.HandleFunc("/api/v1/shares/", store.handleShare)
	mux.HandleFunc("/api/v1/channels", active(store.handleChannels))
	mux.HandleFunc("/api/v1/channels/", active(store.handleChannelItem))
	mux.HandleFunc("/api/v1/messages", active(store.handleMessages))
	mux.HandleFunc("/api/v1/messages/", active(store.handleMessageItem))
	mux.HandleFunc("/api/v1/code/", active(store.handleCode))
	mux.HandleFunc("/api/v1/runners", active(store.handleRunners))
	mux.HandleFunc("/api/v1/runners/registration-tokens", active(store.handleRunnerRegistrationTokens))
	mux.HandleFunc("/api/v1/runners/register", store.handleRunnerRegister)
	mux.HandleFunc("/api/v1/runners/heartbeat", store.handleRunnerHeartbeat)
	mux.HandleFunc("/api/v1/runners/", active(store.handleRunnerItem))
	mux.HandleFunc("/api/v1/plugins", active(store.handlePlugins))
	mux.HandleFunc("/api/v1/plugins/", active(store.handlePluginItem))
	mux.HandleFunc("/api/v1/metrics", active(store.handleMetrics))
}

func (s *mvpStore) handleResources(w http.ResponseWriter, r *http.Request) {
	principal, _ := principalForRequest(s.authFromHub(), r)
	if r.Method == http.MethodPost {
		if !roleAllows(principal.Role, "resource.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
			return
		}
		var input struct {
			Type     string                 `json:"type"`
			Name     string                 `json:"name"`
			ParentID string                 `json:"parentId"`
			Meta     map[string]interface{} `json:"meta"`
			ACL      protocol.ResourceACL   `json:"acl"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input) != nil || strings.TrimSpace(input.Name) == "" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "resource name is required")
			return
		}
		if input.Type == "" {
			input.Type = "folder"
		}
		if input.ParentID != "" {
			s.mu.RLock()
			_, exists := s.state.Resources[input.ParentID]
			s.mu.RUnlock()
			if !exists {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "parent resource not found")
				return
			}
		}
		var random [12]byte
		if _, err := cryptorand.Read(random[:]); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create resource id")
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		item := protocol.ResourceRecord{ID: "res_" + base64.RawURLEncoding.EncodeToString(random[:]), WorkspaceID: "demo", Type: input.Type, Name: strings.TrimSpace(input.Name), ParentID: input.ParentID, OwnerID: principal.UserID, ACL: input.ACL, Meta: input.Meta, CreatedAt: now, UpdatedAt: now}
		s.mu.Lock()
		s.state.Resources[item.ID] = item
		s.persistLocked()
		s.mu.Unlock()
		s.recordMutation(r, principal, "resource.create", item.ID, item.Type)
		writeJSON(w, http.StatusCreated, item)
		return
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	type resourcePage struct {
		Items      []protocol.ResourceRecord `json:"items"`
		NextCursor string                    `json:"nextCursor,omitempty"`
	}
	type resourceFilter struct{ Type, ParentID string }
	filter := resourceFilter{Type: strings.TrimSpace(r.URL.Query().Get("type")), ParentID: strings.TrimSpace(r.URL.Query().Get("parentId"))}
	s.mu.RLock()
	items := make([]protocol.ResourceRecord, 0, len(s.state.Resources))
	for _, item := range s.state.Resources {
		if filter.Type != "" && item.Type != filter.Type || filter.ParentID != "" && item.ParentID != filter.ParentID || !resourceAllows(principal, item, "resource.read") {
			continue
		}
		items = append(items, item)
	}
	s.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt < items[j].UpdatedAt })
	start := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("cursor")); err == nil && n >= 0 {
		start = n
	}
	limit := parseLimit(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	if start > len(items) {
		start = len(items)
	}
	end := minInt(start+limit, len(items))
	next := ""
	if end < len(items) {
		next = strconv.Itoa(end)
	}
	writeJSON(w, http.StatusOK, resourcePage{Items: items[start:end], NextCursor: next})
}

func resourceAllows(principal authPrincipal, item protocol.ResourceRecord, action string) bool {
	if principal.Role == roleAdmin || principal.Role == "owner" || item.OwnerID == "" || item.OwnerID == "system" || item.OwnerID == principal.UserID {
		return true
	}
	for _, grant := range item.ACL.Grants {
		if grant.Subject != principal.UserID && grant.Subject != principal.Role && grant.Subject != "*" {
			continue
		}
		for _, candidate := range grant.Actions {
			if candidate == action || candidate == "*" {
				return true
			}
		}
	}
	return false
}

func (s *mvpStore) handleResourceItem(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/resources/"), "/")
	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "resource not found")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	s.mu.RLock()
	item, exists := s.state.Resources[id]
	s.mu.RUnlock()
	if !exists {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "resource not found")
		return
	}
	if len(parts) > 1 && parts[1] == "share" {
		if r.Method != http.MethodPost || !resourceAllows(principal, item, "resource.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
			return
		}
		var input struct {
			TTLSeconds int `json:"ttlSeconds"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 8*1024)).Decode(&input)
		if input.TTLSeconds <= 0 || input.TTLSeconds > 24*60*60 {
			input.TTLSeconds = 15 * 60
		}
		var random [24]byte
		if _, err := cryptorand.Read(random[:]); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create share link")
			return
		}
		now := time.Now().UTC()
		share := protocol.ResourceShareLink{Token: base64.RawURLEncoding.EncodeToString(random[:]), ResourceID: id, ExpiresAt: now.Add(time.Duration(input.TTLSeconds) * time.Second).Format(time.RFC3339), SingleUse: true, CreatedBy: principal.UserID, CreatedAt: now.Format(time.RFC3339)}
		s.mu.Lock()
		s.state.Shares[share.Token] = share
		s.persistLocked()
		s.mu.Unlock()
		s.recordMutation(r, principal, "resource.share.create", id, share.ExpiresAt)
		writeJSON(w, http.StatusCreated, share)
		return
	}
	if !resourceAllows(principal, item, "resource.read") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.read permission required")
		return
	}
	if r.Method == http.MethodPatch {
		if !resourceAllows(principal, item, "resource.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
			return
		}
		var input struct {
			Name string                 `json:"name"`
			Meta map[string]interface{} `json:"meta"`
			ACL  *protocol.ResourceACL  `json:"acl"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input) != nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid resource update")
			return
		}
		s.mu.Lock()
		if input.Name != "" {
			item.Name = strings.TrimSpace(input.Name)
		}
		if input.Meta != nil {
			item.Meta = input.Meta
		}
		if input.ACL != nil {
			item.ACL = *input.ACL
		}
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		s.state.Resources[id] = item
		s.persistLocked()
		s.mu.Unlock()
		s.recordMutation(r, principal, "resource.update", id, item.Name)
	}
	if r.Method == http.MethodGet {
		s.mu.Lock()
		item.LastAccessedAt = time.Now().UTC().Format(time.RFC3339)
		s.state.Resources[id] = item
		s.persistLocked()
		s.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *mvpStore) handleShare(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/shares/"), "/")
	parts := strings.Split(path, "/")
	token := parts[0]
	if token == "" {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "share link not found")
		return
	}
	s.mu.Lock()
	share, ok := s.state.Shares[token]
	if !ok || share.RevokedAt != "" {
		s.mu.Unlock()
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "share link not found")
		return
	}
	expires, err := time.Parse(time.RFC3339, share.ExpiresAt)
	if err != nil || time.Now().UTC().After(expires) || share.UsedAt != "" {
		s.mu.Unlock()
		writeAPIError(w, http.StatusGone, "ACCESS_REVOKED", "share link has expired or was used")
		return
	}
	if len(parts) > 1 && parts[1] == "content" {
		if r.Method != http.MethodGet {
			s.mu.Unlock()
			writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
			return
		}
		if share.SingleUse {
			share.UsedAt = time.Now().UTC().Format(time.RFC3339)
			s.state.Shares[token] = share
			s.persistLocked()
		}
		resourceID := share.ResourceID
		s.mu.Unlock()
		r.URL.Path = "/api/v1/files/" + resourceID + "/content"
		// The share token is the authorization for this one-time download.
		if content := s.contentHandler(); content != nil {
			content(w, r)
			return
		}
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "resource content unavailable")
		return
	}
	shareResource := share.ResourceID
	if share.SingleUse {
		share.UsedAt = time.Now().UTC().Format(time.RFC3339)
		s.state.Shares[token] = share
		s.persistLocked()
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{"resourceId": shareResource, "expiresAt": share.ExpiresAt, "usedAt": share.UsedAt})
}

func (s *mvpStore) contentHandler() http.HandlerFunc { return s.contentDownload }

func (s *mvpStore) handleChannels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		principal, _ := principalForRequest(s.authFromHub(), r)
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": s.listChannelsFor(principal), "nextCursor": ""})
	case http.MethodPost:
		principal, _ := principalForRequest(s.authFromHub(), r)
		if !roleAllows(principal.Role, "resource.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
			return
		}
		var input struct {
			Name      string   `json:"name"`
			Kind      string   `json:"kind"`
			MemberIDs []string `json:"memberIds"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.Name) == "" {
			writeAPIError(w, 400, "INVALID_REQUEST", "channel name is required")
			return
		}
		id := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(input.Name), " ", "-"))
		if id == "" {
			writeAPIError(w, 400, "INVALID_REQUEST", "invalid channel name")
			return
		}
		if input.Kind != "direct" {
			input.Kind = "channel"
		}
		s.mu.Lock()
		if _, exists := s.state.Channels[id]; exists {
			s.mu.Unlock()
			writeAPIError(w, 409, "INVALID_REQUEST", "channel already exists")
			return
		}
		item := protocol.ChatChannel{ID: id, WorkspaceID: "demo", Name: input.Name, Kind: input.Kind, MemberIDs: input.MemberIDs, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
		s.state.Channels[id] = item
		s.persistLocked()
		s.mu.Unlock()
		s.recordMutation(r, principal, "channel.create", id, input.Kind)
		writeJSON(w, 201, item)
	default:
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
	}
}

func (s *mvpStore) handleChannelItem(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/channels/"), "/")
	if path == "" {
		writeAPIError(w, 404, "INVALID_REQUEST", "channel not found")
		return
	}
	if strings.HasSuffix(path, "/messages") {
		r.URL.Path = "/api/v1/messages"
		r.URL.RawQuery = addQuery(r.URL.RawQuery, "channelId", strings.TrimSuffix(path, "/messages"))
		s.handleMessages(w, r)
		return
	}
	s.mu.RLock()
	item, ok := s.state.Channels[path]
	s.mu.RUnlock()
	if !ok {
		writeAPIError(w, 404, "INVALID_REQUEST", "channel not found")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !channelAllows(principal, item) {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "channel membership required")
		return
	}
	writeJSON(w, 200, item)
}

func addQuery(raw, key, value string) string {
	if raw == "" {
		return key + "=" + value
	}
	return raw + "&" + key + "=" + value
}

func (s *mvpStore) handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		started := time.Now()
		principal, _ := principalForRequest(s.authFromHub(), r)
		channelID := r.URL.Query().Get("channelId")
		if channelID != "" {
			s.mu.RLock()
			channel, exists := s.state.Channels[channelID]
			s.mu.RUnlock()
			if !exists {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "channel not found")
				return
			}
			if !channelAllows(principal, channel) {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "channel membership required")
				return
			}
		}
		items, next := s.listMessagesFiltered(channelID, r.URL.Query().Get("authorId"), r.URL.Query().Get("q"), r.URL.Query().Get("from"), r.URL.Query().Get("to"), r.URL.Query().Get("cursor"), parseLimit(r.URL.Query().Get("limit")))
		if r.URL.Query().Get("q") != "" {
			messageSearchRequests.Add(1)
			messageSearchNanos.Add(time.Since(started).Nanoseconds())
		}
		writeJSON(w, 200, map[string]interface{}{"items": items, "nextCursor": next})
		return
	}
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !roleAllows(principal.Role, "chat.send") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "chat.send permission required")
		return
	}
	var input protocol.MessageCreateInput
	if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.Body) == "" || strings.TrimSpace(input.ChannelID) == "" {
		writeAPIError(w, 400, "INVALID_REQUEST", "body and channelId are required")
		return
	}
	s.mu.RLock()
	channel, exists := s.state.Channels[input.ChannelID]
	s.mu.RUnlock()
	if !exists {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "channel not found")
		return
	}
	if !channelAllows(principal, channel) {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "channel membership required")
		return
	}
	if input.ClientMsgID == "" {
		input.ClientMsgID = ""
	}
	e, duplicate := s.hub.publishMessage(strings.TrimSpace(input.Body), input.ChannelID, input.ClientMsgID)
	if !duplicate {
		s.addMessage(protocol.ChatMessage{ID: e.EventID, ChannelID: input.ChannelID, ThreadID: input.ThreadID, AuthorID: principal.UserID, AuthorName: principal.DisplayName, Body: input.Body, Blocks: input.Blocks, Mentions: input.Mentions, ClientMsgID: input.ClientMsgID, CreatedAt: e.TS, Version: 1})
		s.recordMutation(r, principal, "message.create", e.EventID, input.ChannelID)
	}
	status := http.StatusCreated
	state := "accepted"
	if duplicate {
		status = http.StatusOK
		state = "duplicate"
	}
	writeJSON(w, status, protocol.AcceptedMessage{MessageID: e.EventID, ServerMsgID: e.EventID, Seq: e.Seq, Status: state})
}

// authFromHub is replaced by registerMVPAuth when the routes are installed.
// Keeping the pointer on the store avoids widening the existing hub API.
func (s *mvpStore) authFromHub() *authStore { return mvpAuthRegistry(s) }

var mvpAuthMu sync.RWMutex
var mvpAuthByStore = map[*mvpStore]*authStore{}

func registerMVPAuth(store *mvpStore, auth *authStore) {
	mvpAuthMu.Lock()
	mvpAuthByStore[store] = auth
	mvpAuthMu.Unlock()
}
func mvpAuthRegistry(store *mvpStore) *authStore {
	mvpAuthMu.RLock()
	defer mvpAuthMu.RUnlock()
	return mvpAuthByStore[store]
}

func parseLimit(raw string) int {
	if n, err := strconv.Atoi(raw); err == nil {
		return n
	}
	return 50
}

func (s *mvpStore) handleMessageItem(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/messages/"), "/")
	if path == "" {
		writeAPIError(w, 404, "INVALID_REQUEST", "message not found")
		return
	}
	if strings.HasSuffix(path, "/thread") {
		id := strings.TrimSuffix(path, "/thread")
		s.mu.RLock()
		root, exists := s.state.Messages[id]
		channel := s.state.Channels[root.ChannelID]
		s.mu.RUnlock()
		principal, _ := principalForRequest(s.authFromHub(), r)
		if !exists {
			writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "message not found")
			return
		}
		if !channelAllows(principal, channel) {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "channel membership required")
			return
		}
		items, _ := s.listMessages("", "", "", 200)
		filtered := make([]protocol.ChatMessage, 0)
		for _, m := range items {
			if m.ThreadID == id || m.ID == id {
				filtered = append(filtered, m)
			}
		}
		writeJSON(w, 200, map[string]interface{}{"items": filtered})
		return
	}
	switch r.Method {
	case http.MethodPatch:
		principal, _ := principalForRequest(s.authFromHub(), r)
		if !roleAllows(principal.Role, "chat.send") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "chat.send permission required")
			return
		}
		var input struct {
			Body   string                  `json:"body"`
			Blocks []protocol.MessageBlock `json:"blocks"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.Body) == "" {
			writeAPIError(w, 400, "INVALID_REQUEST", "body is required")
			return
		}
		if principal.Role == roleMember {
			s.mu.RLock()
			original, exists := s.state.Messages[path]
			s.mu.RUnlock()
			if !exists {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "message not found")
				return
			}
			if original.AuthorID != principal.UserID {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "message ownership required")
				return
			}
		}
		updated, ok := s.updateMessage(path, func(m *protocol.ChatMessage) {
			m.Body = input.Body
			m.Blocks = input.Blocks
			m.EditedAt = time.Now().UTC().Format(time.RFC3339)
		})
		if !ok {
			writeAPIError(w, 404, "INVALID_REQUEST", "message not found")
			return
		}
		s.hub.emit("chat.message.updated", updated)
		s.recordMutation(r, principal, "message.update", path, updated.ChannelID)
		writeJSON(w, 200, updated)
	case http.MethodDelete:
		principal, _ := principalForRequest(s.authFromHub(), r)
		if !roleAllows(principal.Role, "chat.send") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "chat.send permission required")
			return
		}
		if principal.Role == roleMember {
			s.mu.RLock()
			original, exists := s.state.Messages[path]
			s.mu.RUnlock()
			if !exists {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "message not found")
				return
			}
			if original.AuthorID != principal.UserID {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "message ownership required")
				return
			}
		}
		updated, ok := s.updateMessage(path, func(m *protocol.ChatMessage) { m.DeletedAt = time.Now().UTC().Format(time.RFC3339) })
		if !ok {
			writeAPIError(w, 404, "INVALID_REQUEST", "message not found")
			return
		}
		s.hub.emit("chat.message.deleted", map[string]string{"messageId": path, "deletedAt": updated.DeletedAt})
		s.recordMutation(r, principal, "message.delete", path, updated.ChannelID)
		writeJSON(w, 200, updated)
	default:
		s.mu.RLock()
		item, ok := s.state.Messages[path]
		s.mu.RUnlock()
		if !ok {
			writeAPIError(w, 404, "INVALID_REQUEST", "message not found")
			return
		}
		writeJSON(w, 200, item)
	}
}

func (s *mvpStore) handleCode(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/code/"), "/")
	if path == "files" && r.Method == http.MethodPost {
		principal, _ := principalForRequest(s.authFromHub(), r)
		if !roleAllows(principal.Role, "code.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "code.write permission required")
			return
		}
		var input struct {
			ProjectID string `json:"projectId"`
			Path      string `json:"path"`
			Language  string `json:"language"`
			Content   string `json:"content"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 5*1024*1024+64*1024)).Decode(&input) != nil || strings.TrimSpace(input.ProjectID) == "" || strings.TrimSpace(input.Path) == "" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "projectId and path are required")
			return
		}
		clean := filepath.ToSlash(filepath.Clean(input.Path))
		if filepath.IsAbs(input.Path) || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "code path must stay inside the project")
			return
		}
		if len(input.Content) > 5*1024*1024 {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "QUOTA_EXCEEDED", "files larger than 5 MiB are read-only")
			return
		}
		s.mu.Lock()
		for _, file := range s.state.CodeFiles {
			if file.ProjectID == input.ProjectID && file.Path == clean {
				s.mu.Unlock()
				writeAPIError(w, http.StatusConflict, "INVALID_REQUEST", "code path already exists")
				return
			}
		}
		id := "code_file_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 36)
		hash := sha256.Sum256([]byte(input.Content))
		now := time.Now().UTC().Format(time.RFC3339)
		file := protocol.CodeFile{ID: id, ProjectID: input.ProjectID, Path: clean, Language: strings.TrimSpace(input.Language), Size: int64(len(input.Content)), ContentHash: hex.EncodeToString(hash[:]), Version: "v1", UpdatedAt: now}
		version := protocol.CodeVersion{ID: "codever_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10), FileID: id, Version: "v1", ContentHash: file.ContentHash, Content: input.Content, CreatedBy: principal.UserID, CreatedAt: now}
		s.state.CodeFiles[id] = file
		s.state.CodeData[id] = input.Content
		s.state.CodeVers[id] = []protocol.CodeVersion{version}
		s.persistLocked()
		s.mu.Unlock()
		s.hub.emit("code.version.created", version)
		s.recordMutation(r, principal, "code.file.create", id, clean)
		writeJSON(w, http.StatusCreated, map[string]interface{}{"file": file, "version": version})
		return
	}
	if path == "projects" || path == "projects/" {
		files := []protocol.CodeFile{}
		s.mu.RLock()
		for _, f := range s.state.CodeFiles {
			files = append(files, f)
		}
		s.mu.RUnlock()
		writeJSON(w, 200, map[string]interface{}{"items": files, "nextCursor": ""})
		return
	}
	if strings.HasPrefix(path, "projects/") {
		parts := strings.Split(strings.TrimPrefix(path, "projects/"), "/")
		project := parts[0]
		files := []protocol.CodeFile{}
		s.mu.RLock()
		for _, f := range s.state.CodeFiles {
			if f.ProjectID == project {
				files = append(files, f)
			}
		}
		s.mu.RUnlock()
		writeJSON(w, 200, map[string]interface{}{"items": files, "nextCursor": ""})
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[0] != "files" {
		writeAPIError(w, 404, "INVALID_REQUEST", "code resource not found")
		return
	}
	id := parts[1]
	if len(parts) == 2 && r.Method == http.MethodGet {
		f, c, ok := s.codeFile(id)
		if !ok {
			writeAPIError(w, 404, "INVALID_REQUEST", "code file not found")
			return
		}
		const maxLines = 2000
		lines := strings.Split(c, "\n")
		start := 0
		if raw := r.URL.Query().Get("lineStart"); raw != "" {
			start = maxInt(0, parseLimit(raw))
		}
		if start > len(lines) {
			start = len(lines)
		}
		end := len(lines)
		if end > start+maxLines {
			end = start + maxLines
		}
		limited := strings.Join(lines[start:end], "\n")
		writeJSON(w, 200, map[string]interface{}{"file": f, "content": limited, "lineStart": start, "lineEnd": end, "totalLines": len(lines), "truncated": end < len(lines)})
		return
	}
	if len(parts) >= 3 && parts[2] == "versions" {
		s.mu.RLock()
		vers := append([]protocol.CodeVersion(nil), s.state.CodeVers[id]...)
		s.mu.RUnlock()
		writeJSON(w, 200, map[string]interface{}{"items": vers, "nextCursor": ""})
		return
	}
	if len(parts) >= 3 && parts[2] == "save" && r.Method == http.MethodPost {
		var input protocol.CodeSaveInput
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			writeAPIError(w, 400, "INVALID_REQUEST", "invalid save input")
			return
		}
		p, _ := principalForRequest(s.authFromHub(), r)
		if !roleAllows(p.Role, "code.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "code.write permission required")
			return
		}
		if len(input.Content) > 5*1024*1024 {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "QUOTA_EXCEEDED", "files larger than 5 MiB are read-only")
			return
		}
		force := r.URL.Query().Get("force") == "true"
		if force && p.Role != roleAdmin && p.Role != "owner" {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "admin role required for force save")
			return
		}
		version, conflict, err := s.saveCode(id, input.Content, input.BaseVersion, p.UserID, input.Message, force)
		if errors.Is(err, os.ErrNotExist) {
			writeAPIError(w, 404, "INVALID_REQUEST", "code file not found")
			return
		}
		if conflict != nil {
			writeJSON(w, 409, conflict)
			return
		}
		s.hub.emit("code.version.created", version)
		s.recordMutation(r, p, "code.version.create", id, version.Version)
		writeJSON(w, 200, version)
		return
	}
	writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
}

func (s *mvpStore) handleRunners(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"items": s.listRunners(), "nextCursor": ""})
}

func newRunnerSecret() (string, error) {
	secret := make([]byte, 32)
	if _, err := cryptorand.Read(secret); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}

func runnerTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func (s *mvpStore) consumeRunnerRegistrationToken(raw string) bool {
	raw = strings.TrimSpace(raw)
	configured := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN"))
	if raw == "" {
		return false
	}
	digest := runnerTokenDigest(raw)
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	if token, ok := s.state.RunnerRegistrationTokens[digest]; ok {
		expiresAt, err := time.Parse(time.RFC3339, token.ExpiresAt)
		if token.UsedAt != "" || err != nil || !now.Before(expiresAt) {
			return false
		}
		token.UsedAt = now.Format(time.RFC3339)
		s.state.RunnerRegistrationTokens[digest] = token
		s.persistLocked()
		return true
	}
	if configured == "" || subtle.ConstantTimeCompare([]byte(configured), []byte(raw)) != 1 {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("LINKOS_ENV")), "production") {
		return false
	}
	// LINKOS_RUNNER_REGISTRATION_TOKEN is the legacy/reconnect bootstrap
	// credential. Admin-issued registration tokens above are the one-time path.
	return true
}

func runnerCredentialFromRequest(r *http.Request) string {
	if credential := strings.TrimSpace(r.Header.Get("X-Runner-Credential")); credential != "" {
		return credential
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authorization) > len("Runner ") && strings.EqualFold(authorization[:len("Runner ")], "Runner ") {
		return strings.TrimSpace(authorization[len("Runner "):])
	}
	return ""
}

func (s *mvpStore) runnerCredentialAllowed(id string, r *http.Request) bool {
	raw := runnerCredentialFromRequest(r)
	if raw == "" {
		raw = strings.TrimSpace(r.Header.Get("X-Runner-Token"))
	}
	digest := runnerTokenDigest(raw)
	s.mu.RLock()
	credential, ok := s.state.RunnerCredentials[id]
	s.mu.RUnlock()
	if ok {
		return credential.RevokedAt == "" && subtle.ConstantTimeCompare([]byte(credential.Digest), []byte(digest)) == 1
	}
	// Legacy development runners may use the static token until they complete
	// the one-time registration flow. Production never permits an empty token.
	configured := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN"))
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("LINKOS_ENV")), "production") && configured != "" && subtle.ConstantTimeCompare([]byte(configured), []byte(raw)) == 1
}

func (s *mvpStore) issueRunnerCredentialLocked(id string) (string, int, error) {
	secret, err := newRunnerSecret()
	if err != nil {
		return "", 0, err
	}
	version := s.state.RunnerCredentials[id].Version + 1
	s.state.RunnerCredentials[id] = runnerCredential{Digest: runnerTokenDigest(secret), Version: version}
	return secret, version, nil
}

func (s *mvpStore) handleRunnerRegistrationTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !roleAllows(principal.Role, "runner.manage") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "runner.manage permission required")
		return
	}
	secret, err := newRunnerSecret()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create runner registration token")
		return
	}
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	s.mu.Lock()
	s.state.RunnerRegistrationTokens[runnerTokenDigest(secret)] = runnerRegistrationToken{ExpiresAt: expiresAt.Format(time.RFC3339), CreatedBy: principal.UserID}
	s.persistLocked()
	s.mu.Unlock()
	s.recordMutation(r, principal, "runner.registration-token.create", "runner", expiresAt.Format(time.RFC3339))
	writeJSON(w, http.StatusCreated, map[string]interface{}{"token": secret, "expiresAt": expiresAt.Format(time.RFC3339), "singleUse": true})
}

func (s *mvpStore) handleRunnerRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	var input protocol.RunnerInfo
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&input); err != nil || strings.TrimSpace(input.ID) == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "runner id is required")
		return
	}
	if !s.consumeRunnerRegistrationToken(r.Header.Get("X-Runner-Token")) {
		writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner registration token required")
		return
	}
	input.WorkspaceID = "demo"
	input.Status = "online"
	input.RevokedAt = ""
	input.LastSeenAt = time.Now().UTC().Format(time.RFC3339)
	s.mu.Lock()
	credential, version, err := s.issueRunnerCredentialLocked(input.ID)
	if err != nil {
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not issue runner credential")
		return
	}
	input.CredentialVersion = version
	s.state.Runners[input.ID] = input
	s.persistLocked()
	s.mu.Unlock()
	s.hub.emit("runner.updated", input)
	if s.audit != nil {
		s.audit.record(auditEntry{ActorUserID: "runner:" + input.ID, ActorName: input.ID, Action: "runner.register", Target: input.ID, RemoteAddr: r.RemoteAddr})
	}
	writeJSON(w, http.StatusCreated, struct {
		protocol.RunnerInfo
		Runner     protocol.RunnerInfo `json:"runner"`
		Credential string              `json:"credential"`
	}{RunnerInfo: input, Runner: input, Credential: credential})
}

func (s *mvpStore) handleRunnerHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	var input struct {
		ID     string            `json:"id"`
		Status string            `json:"status"`
		Labels map[string]string `json:"labels"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&input) != nil || strings.TrimSpace(input.ID) == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "runner id is required")
		return
	}
	if !s.runnerCredentialAllowed(input.ID, r) {
		writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner credential is invalid or revoked")
		return
	}
	s.mu.Lock()
	item, ok := s.state.Runners[input.ID]
	if !ok {
		s.mu.Unlock()
		writeAPIError(w, http.StatusNotFound, "RUNNER_UNAVAILABLE", "runner not registered")
		return
	}
	if input.Status != "" && item.Status != "paused" && item.Status != "draining" {
		item.Status = input.Status
	}
	if input.Labels != nil {
		item.Labels = input.Labels
	}
	item.LastSeenAt = time.Now().UTC().Format(time.RFC3339)
	s.state.Runners[input.ID] = item
	s.persistLocked()
	s.mu.Unlock()
	s.hub.emit("runner.updated", item)
	writeJSON(w, http.StatusOK, item)
}
func (s *mvpStore) handleRunnerItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/runners/"), "/"), "/")
	id := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	s.mu.RLock()
	item, ok := s.state.Runners[id]
	s.mu.RUnlock()
	if !ok {
		writeAPIError(w, 404, "RUNNER_UNAVAILABLE", "runner not found")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if (r.Method == http.MethodPatch || r.Method == http.MethodDelete || action != "") && !roleAllows(principal.Role, "runner.manage") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "runner.manage permission required")
		return
	}
	if r.Method == http.MethodDelete && action == "" {
		s.mu.Lock()
		delete(s.state.Runners, id)
		delete(s.state.RunnerCredentials, id)
		s.persistLocked()
		s.mu.Unlock()
		s.recordMutation(r, principal, "runner.delete", id, "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
		return
	}
	if r.Method == http.MethodPost && action == "rotate-token" {
		s.mu.Lock()
		credential, version, err := s.issueRunnerCredentialLocked(id)
		if err == nil {
			item.CredentialVersion = version
			item.RevokedAt = ""
			s.state.Runners[id] = item
			s.persistLocked()
		}
		s.mu.Unlock()
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not rotate runner credential")
			return
		}
		s.hub.emit("runner.updated", item)
		s.recordMutation(r, principal, "runner.token.rotate", id, strconv.Itoa(version))
		writeJSON(w, http.StatusOK, map[string]interface{}{"runner": item, "credential": credential})
		return
	}
	if r.Method == http.MethodPost && action == "revoke" {
		now := time.Now().UTC().Format(time.RFC3339)
		s.mu.Lock()
		credential := s.state.RunnerCredentials[id]
		credential.RevokedAt = now
		s.state.RunnerCredentials[id] = credential
		item.Status, item.RevokedAt = "offline", now
		s.state.Runners[id] = item
		s.persistLocked()
		s.mu.Unlock()
		s.hub.emit("runner.updated", item)
		s.recordMutation(r, principal, "runner.revoke", id, "")
		writeJSON(w, http.StatusOK, item)
		return
	}
	if action != "" {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "unknown runner action")
		return
	}
	if r.Method == http.MethodPatch {
		var body struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Status != "online" && body.Status != "paused" && body.Status != "draining" && body.Status != "offline" {
			writeAPIError(w, 400, "INVALID_REQUEST", "invalid runner status")
			return
		}
		s.mu.Lock()
		item.Status = body.Status
		item.LastSeenAt = time.Now().UTC().Format(time.RFC3339)
		s.state.Runners[id] = item
		s.persistLocked()
		s.mu.Unlock()
		s.hub.emit("runner.updated", item)
		s.recordMutation(r, principal, "runner.status.update", id, body.Status)
		writeJSON(w, http.StatusOK, item)
		return
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *mvpStore) handlePlugins(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	writeJSON(w, 200, map[string]interface{}{"items": s.listPlugins(), "nextCursor": ""})
}
func (s *mvpStore) handlePluginItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/plugins/"), "/"), "/")
	id := parts[0]
	if id == "" {
		writeAPIError(w, 404, "PLUGIN_INCOMPATIBLE", "plugin not found")
		return
	}
	status := ""
	if len(parts) > 1 {
		status = parts[1]
	}
	var target protocol.PluginStatus
	switch status {
	case "enable":
		target = "enabled"
	case "disable":
		target = "disabled"
	case "install":
		target = "installed"
	case "rollback":
		target = "rollback"
	case "uninstall":
		target = "uninstalled"
	case "health-failed":
		target = "failed"
	default:
		writeAPIError(w, 404, "PLUGIN_INCOMPATIBLE", "unknown plugin action")
		return
	}
	if r.Method != "POST" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	permission := "plugin.manage"
	if status == "install" {
		permission = "plugin.install"
	}
	if !roleAllows(principal.Role, permission) {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", permission+" permission required")
		return
	}
	if status == "install" {
		var input struct {
			Manifest  protocol.PluginManifest `json:"manifest"`
			Signature string                  `json:"signature"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input); err != nil || len(validatePluginManifest(input.Manifest)) > 0 {
			writeAPIError(w, http.StatusBadRequest, "PLUGIN_INCOMPATIBLE", "invalid plugin manifest")
			return
		}
		if input.Manifest.ID != id {
			writeAPIError(w, http.StatusBadRequest, "PLUGIN_INCOMPATIBLE", "manifest id does not match route")
			return
		}
		keys := pluginTrustedKeys()
		if (pluginSignaturesRequired() && len(keys) == 0) || !verifyPluginSignature(input.Manifest, input.Signature, keys) {
			writeAPIError(w, http.StatusBadRequest, "PLUGIN_INCOMPATIBLE", "plugin signature is not trusted")
			return
		}
		s.mu.Lock()
		var previous *protocol.PluginPrevious
		if current, exists := s.state.Plugins[id]; exists {
			previous = &protocol.PluginPrevious{Manifest: current.Manifest, Signature: current.Signature, Status: current.Status}
		}
		s.state.Plugins[id] = protocol.PluginRecord{ID: input.Manifest.ID, Name: input.Manifest.Name, Version: input.Manifest.Version, APIVersion: input.Manifest.APIVersion, Status: "installed", Manifest: input.Manifest, Signature: input.Signature, Permissions: input.Manifest.Permissions, Health: "healthy", InstalledAt: time.Now().UTC().Format(time.RFC3339), Previous: previous}
		s.persistLocked()
		item := s.state.Plugins[id]
		s.mu.Unlock()
		s.hub.emit("plugin.updated", item)
		s.recordMutation(r, principal, "plugin.install", id, input.Manifest.Version)
		writeJSON(w, http.StatusCreated, item)
		return
	}
	item, ok := s.setPluginStatus(id, target)
	if !ok {
		writeAPIError(w, 404, "PLUGIN_INCOMPATIBLE", "plugin not found")
		return
	}
	s.hub.emit("plugin.updated", item)
	s.recordMutation(r, principal, "plugin."+status, id, item.Version)
	writeJSON(w, 200, item)
}

func (s *mvpStore) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	s.mu.RLock()
	jobs := len(s.state.Jobs)
	messages := len(s.state.Messages)
	plugins := len(s.state.Plugins)
	statuses := make(map[protocol.JobStatus]int)
	for _, job := range s.state.Jobs {
		statuses[job.Ref.Status]++
	}
	onlineRunners := 0
	for _, runner := range s.state.Runners {
		if runner.Status == "online" {
			onlineRunners++
		}
	}
	s.mu.RUnlock()
	s.hub.mu.Lock()
	connections := len(s.hub.clients)
	s.hub.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "linkos_messages_total %d\nlinkos_jobs_total %d\nlinkos_plugins_total %d\nlinkos_event_seq %d\nlinkos_ws_connections %d\nlinkos_ws_unknown_events_total %d\nlinkos_ws_slow_client_total %d\nlinkos_runners_online %d\nlinkos_message_search_requests_total %d\nlinkos_message_search_duration_seconds_sum %.6f\n", messages, jobs, plugins, s.hub.store.CurrentSeq(), connections, unknownWSEvents.Load(), slowWSClients.Load(), onlineRunners, messageSearchRequests.Load(), float64(messageSearchNanos.Load())/float64(time.Second))
	for status, count := range statuses {
		fmt.Fprintf(w, "linkos_jobs_status{status=%q} %d\n", status, count)
	}
}

func runMVPJob(store *mvpStore, id string) {
	if _, ok := store.setJobStatus(id, "preparing"); !ok {
		return
	}
	job, _ := store.getJob(id)
	store.appendLog(id, "info", "$ "+job.Spec.Command+"\n")
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("LINKOS_RUNNER_URL")), "/")
	if endpoint == "" {
		store.appendLog(id, "error", "execution unavailable: configure LINKOS_RUNNER_URL\n")
		ref, _ := store.setJobStatus(id, "failed")
		store.hub.emit("job.status.changed", ref)
		return
	}
	store.mu.RLock()
	files := make(map[string]string)
	for fileID, file := range store.state.CodeFiles {
		if file.ProjectID == job.Spec.ProjectID {
			files[file.Path] = store.state.CodeData[fileID]
		}
	}
	store.mu.RUnlock()
	payload, _ := json.Marshal(map[string]interface{}{"id": id, "projectId": job.Spec.ProjectID, "command": job.Spec.Command, "timeoutSeconds": job.Spec.TimeoutSeconds, "memoryMb": job.Spec.MemoryMb, "network": job.Spec.Network, "env": job.Spec.Env, "files": files, "artifactGlobs": job.Spec.ArtifactGlobs})
	request, _ := http.NewRequest(http.MethodPost, endpoint+"/jobs", bytes.NewReader(payload))
	request.Header.Set("content-type", "application/json")
	if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")); token != "" {
		request.Header.Set("X-Runner-Token", token)
	}
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		store.appendLog(id, "error", "runner unavailable: "+redactSecrets(err.Error())+"\n")
		ref, _ := store.setJobStatus(id, "failed")
		store.hub.emit("job.status.changed", ref)
		return
	}
	defer response.Body.Close()
	var remote struct {
		ID     string             `json:"id"`
		Status protocol.JobStatus `json:"status"`
		Error  string             `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&remote)
	if response.StatusCode == http.StatusServiceUnavailable {
		store.appendLog(id, "error", "RUNNER_UNAVAILABLE: "+redactSecrets(remote.Error)+"\n")
		ref, _ := store.setJobStatus(id, "failed")
		store.hub.emit("job.status.changed", ref)
		return
	}
	if response.StatusCode >= 300 {
		store.appendLog(id, "error", "runner rejected job: "+redactSecrets(remote.Error)+"\n")
		ref, _ := store.setJobStatus(id, "failed")
		store.hub.emit("job.status.changed", ref)
		return
	}
	if remote.Status == "running" {
		ref, _ := store.setJobStatus(id, "running")
		store.hub.emit("job.status.changed", ref)
	}
	timeoutSeconds := job.Spec.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 600
	}
	deadline := time.Now().Add(time.Duration(timeoutSeconds+10) * time.Second)
	for time.Now().Before(deadline) {
		current, exists := store.getJob(id)
		if !exists || current.Cancel {
			return
		}
		status, logs := fetchRunnerJob(endpoint, id)
		store.mu.RLock()
		gatewayLogCount := len(store.state.JobLogs[id])
		store.mu.RUnlock()
		remoteSeen := maxInt(0, gatewayLogCount-1)
		if len(logs) > remoteSeen {
			for _, item := range logs[remoteSeen:] {
				store.appendLog(id, item.Level, item.Chunk)
			}
		}
		if status != "" {
			if status == "queued" || status == "preparing" || status == "running" {
				ref, _ := store.setJobStatus(id, status)
				store.hub.emit("job.status.changed", ref)
			} else {
				store.ingestRunnerArtifacts(endpoint, id)
				ref, _ := store.setJobStatus(id, status)
				store.hub.emit("job.status.changed", ref)
				return
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	ref, _ := store.setJobStatus(id, "timed_out")
	store.hub.emit("job.status.changed", ref)
}

func fetchRunnerArtifacts(endpoint, id string) []struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentHash string `json:"contentHash"`
	Content     string `json:"content"`
} {
	request, err := http.NewRequest(http.MethodGet, endpoint+"/jobs/"+url.PathEscape(id)+"/artifacts", nil)
	if err != nil {
		return nil
	}
	if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")); token != "" {
		request.Header.Set("X-Runner-Token", token)
	}
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	var body struct {
		Items []struct {
			Name        string `json:"name"`
			Size        int64  `json:"size"`
			ContentHash string `json:"contentHash"`
			Content     string `json:"content"`
		} `json:"items"`
	}
	if response.StatusCode >= 300 || json.NewDecoder(io.LimitReader(response.Body, 20*1024*1024)).Decode(&body) != nil {
		return nil
	}
	return body.Items
}

func (s *mvpStore) ingestRunnerArtifacts(endpoint, jobID string) {
	if s.content == nil {
		return
	}
	for _, artifact := range fetchRunnerArtifacts(endpoint, jobID) {
		if artifact.Name == "" || artifact.Content == "" || artifact.Size < 0 || artifact.Size > 8*1024*1024 {
			continue
		}
		content, err := base64.RawStdEncoding.DecodeString(artifact.Content)
		if err != nil || int64(len(content)) != artifact.Size {
			continue
		}
		hash := sha256.Sum256(content)
		hashText := hex.EncodeToString(hash[:])
		if artifact.ContentHash != "" && artifact.ContentHash != hashText {
			continue
		}
		temporary, err := os.CreateTemp("", "linkos-artifact-")
		if err != nil {
			continue
		}
		path := temporary.Name()
		if _, err = temporary.Write(content); err != nil {
			temporary.Close()
			_ = os.Remove(path)
			continue
		}
		_ = temporary.Close()
		if _, err = s.content.commit(path, hashText); err != nil {
			_ = os.Remove(path)
			continue
		}
		item := protocol.JobArtifact{ID: "artifact_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10), JobID: jobID, Name: artifact.Name, ResourceID: "sha256:" + hashText, Size: int64(len(content)), ContentHash: hashText, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
		s.mu.Lock()
		s.state.Artifacts[item.ID] = item
		s.persistLocked()
		s.mu.Unlock()
	}
}

func fetchRunnerJob(endpoint, id string) (protocol.JobStatus, []protocol.JobLogChunk) {
	client := &http.Client{Timeout: 5 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, endpoint+"/jobs/"+url.PathEscape(id), nil)
	if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")); token != "" {
		request.Header.Set("X-Runner-Token", token)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", nil
	}
	defer response.Body.Close()
	var body struct {
		Status protocol.JobStatus     `json:"status"`
		Logs   []string               `json:"logs"`
		Items  []protocol.JobLogChunk `json:"items"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&body) != nil {
		return "", nil
	}
	logs := body.Items
	for _, raw := range body.Logs {
		logs = append(logs, protocol.JobLogChunk{Level: "info", Chunk: redactSecrets(raw)})
	}
	return body.Status, logs
}

func handleJobRoutes(mux *http.ServeMux, auth *authStore, store *mvpStore) {
	active := func(h http.HandlerFunc) http.HandlerFunc { return requireActive(auth, "demo", h) }
	mux.HandleFunc("/api/v1/jobs", active(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
			return
		}
		var spec protocol.JobSpec
		if json.NewDecoder(r.Body).Decode(&spec) != nil || strings.TrimSpace(spec.ProjectID) == "" || strings.TrimSpace(spec.Command) == "" {
			writeAPIError(w, 400, "INVALID_REQUEST", "projectId and command are required")
			return
		}
		p, _ := principalForRequest(auth, r)
		if !roleAllows(p.Role, "job.submit") {
			writeAPIError(w, 403, "FORBIDDEN", "job.submit permission required")
			return
		}
		if strings.TrimSpace(os.Getenv("LINKOS_RUNNER_URL")) == "" {
			writeAPIError(w, http.StatusServiceUnavailable, "RUNNER_UNAVAILABLE", "no Runner endpoint is configured")
			return
		}
		ref := store.createJob(spec, p.UserID)
		store.recordMutation(r, p, "job.submit", ref.ID, spec.ProjectID)
		store.hub.emit("job.status.changed", ref)
		go runMVPJob(store, ref.ID)
		writeJSON(w, 202, ref)
	}))
	mux.HandleFunc("/api/v1/jobs/", active(func(w http.ResponseWriter, r *http.Request) {
		path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/jobs/"), "/")
		parts := strings.Split(path, "/")
		id := parts[0]
		if id == "" {
			writeAPIError(w, 404, "INVALID_REQUEST", "job not found")
			return
		}
		if len(parts) > 1 && parts[1] == "cancel" {
			p, _ := principalForRequest(auth, r)
			if !roleAllows(p.Role, "job.cancel") {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "job.cancel permission required")
				return
			}
			if r.Method != http.MethodPost {
				writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
				return
			}
			store.mu.Lock()
			job, ok := store.state.Jobs[id]
			if ok {
				job.Cancel = true
				store.state.Jobs[id] = job
				store.persistLocked()
			}
			store.mu.Unlock()
			if !ok {
				writeAPIError(w, 404, "INVALID_REQUEST", "job not found")
				return
			}
			ref, _ := store.setJobStatus(id, "canceled")
			store.recordMutation(r, p, "job.cancel", id, "")
			store.hub.emit("job.status.changed", ref)
			if endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("LINKOS_RUNNER_URL")), "/"); endpoint != "" {
				if request, err := http.NewRequest(http.MethodPost, endpoint+"/jobs/"+url.PathEscape(id)+"/cancel", nil); err == nil {
					if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")); token != "" {
						request.Header.Set("X-Runner-Token", token)
					}
					go func() {
						response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
						if err == nil {
							_ = response.Body.Close()
						}
					}()
				}
			}
			writeJSON(w, 200, ref)
			return
		}
		if len(parts) > 1 && parts[1] == "logs" {
			if _, ok := store.getJob(id); !ok {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "job not found")
				return
			}
			store.mu.RLock()
			logs := append([]protocol.JobLogChunk(nil), store.state.JobLogs[id]...)
			store.mu.RUnlock()
			start := 0
			if raw := r.URL.Query().Get("cursor"); raw != "" {
				start = maxInt(0, parseLimit(raw))
			}
			limit := parseLimit(r.URL.Query().Get("limit"))
			if limit < 1 || limit > 200 {
				limit = 50
			}
			if start >= len(logs) {
				writeJSON(w, 200, map[string]interface{}{"items": []protocol.JobLogChunk{}, "nextCursor": ""})
				return
			}
			end := minInt(start+limit, len(logs))
			next := ""
			if end < len(logs) {
				next = strconv.Itoa(end)
			}
			writeJSON(w, 200, map[string]interface{}{"items": logs[start:end], "nextCursor": next})
			return
		}
		if len(parts) > 1 && parts[1] == "artifacts" {
			if _, ok := store.getJob(id); !ok {
				writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "job not found")
				return
			}
			store.mu.RLock()
			artifacts := make([]protocol.JobArtifact, 0)
			for _, artifact := range store.state.Artifacts {
				if artifact.JobID == id {
					artifacts = append(artifacts, artifact)
				}
			}
			store.mu.RUnlock()
			writeJSON(w, 200, map[string]interface{}{"items": artifacts, "nextCursor": ""})
			return
		}
		job, ok := store.getJob(id)
		if !ok {
			writeAPIError(w, 404, "INVALID_REQUEST", "job not found")
			return
		}
		writeJSON(w, 200, job.Ref)
	}))
}

// Keep io/path imports useful for the forthcoming artifact handler and make
// path traversal checks explicit at the API boundary.
func safeArtifactPath(root, name string) (string, error) {
	clean := filepath.Clean(name)
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", errors.New("invalid artifact path")
	}
	target := filepath.Join(root, clean)
	if !strings.HasPrefix(target, filepath.Clean(root)+string(os.PathSeparator)) {
		return "", errors.New("invalid artifact path")
	}
	return target, nil
}
func copyLimited(dst io.Writer, src io.Reader, max int64) error {
	_, err := io.Copy(dst, io.LimitReader(src, max+1))
	return err
}
