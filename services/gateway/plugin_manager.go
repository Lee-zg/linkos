package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

type pluginStateBackend interface {
	loadPluginState() (map[string]protocol.PluginRecord, bool, error)
	savePluginState(map[string]protocol.PluginRecord) error
}

func (b *sqliteBackend) loadPluginState() (map[string]protocol.PluginRecord, bool, error) {
	var raw string
	err := b.db.QueryRow(`SELECT payload FROM plugin_registry WHERE id=1`).Scan(&raw)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	records := map[string]protocol.PluginRecord{}
	err = json.Unmarshal([]byte(raw), &records)
	if records == nil {
		records = map[string]protocol.PluginRecord{}
	}
	for id, rec := range records {
		if id != rec.ID || !isPluginID(id) {
			return nil, true, fmt.Errorf("invalid plugin registry identity")
		}
	}
	return records, true, err
}
func (b *sqliteBackend) savePluginState(records map[string]protocol.PluginRecord) error {
	raw, err := json.Marshal(records)
	if err != nil {
		return err
	}
	_, err = b.db.Exec(`INSERT INTO plugin_registry(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

type stagedPlugin struct {
	ID                 string                  `json:"stageId"`
	Manifest           protocol.PluginManifest `json:"manifest"`
	Digest             string                  `json:"artifactDigest"`
	Signature          string                  `json:"signature,omitempty"`
	Trusted            bool                    `json:"trusted"`
	ExpectedRevision   int64                   `json:"expectedRevision"`
	AddedPermissions   []string                `json:"addedPermissions"`
	RemovedPermissions []string                `json:"removedPermissions"`
	ExpiresAt          time.Time               `json:"expiresAt"`
	directory          string
	token              string
}
type pluginTicket struct {
	record  protocol.PluginRecord
	stageID string
	token   string
	expires time.Time
	origin  string
}
type pluginRuntime struct {
	mu      sync.Mutex
	stages  map[string]*stagedPlugin
	tickets map[string]pluginTicket
	root    string
	rates   map[string]*pluginRate
}
type pluginRate struct {
	since           time.Time
	count, inflight int
}

func newPluginRuntime() *pluginRuntime {
	root := os.Getenv("LINKOS_DATA_DIR")
	if root != "" {
		root = filepath.Join(root, "plugins")
	} else {
		root, _ = os.MkdirTemp("", "linkos-packages-")
	}
	return &pluginRuntime{root: root, stages: map[string]*stagedPlugin{}, tickets: map[string]pluginTicket{}, rates: map[string]*pluginRate{}}
}
func builtinPlugin(id string) bool {
	return id == "files.core" || id == "chat.core" || id == "code.workbench" || id == "runner.exec"
}
func (s *mvpStore) packageRoot() (string, error) {
	p := s.pluginRuntime
	if p.root == "" {
		return "", fmt.Errorf("plugin storage directory unavailable")
	}
	return p.root, os.MkdirAll(p.root, 0700)
}
func normalizePlugin(rec protocol.PluginRecord) protocol.PluginRecord {
	if rec.Revision < 1 {
		rec.Revision = 1
	}
	if builtinPlugin(rec.ID) {
		rec.Source = "builtin"
		rec.Runtime = "native"
		rec.Previous = nil
		rec.ArtifactDigest = ""
		rec.Signature = ""
	} else {
		rec.Runtime = "iframe"
		if rec.Source == "" {
			rec.Source = "legacy"
		}
	}
	if rec.Permissions == nil {
		rec.Permissions = []string{}
	}
	return rec
}
func (s *mvpStore) normalizePlugins() {
	for id, rec := range s.state.Plugins {
		rec = normalizePlugin(rec)
		if rec.Source == "legacy" {
			rec.Health = "degraded"
			rec.HealthReason = "旧插件需要重新上传完整插件包"
		}
		s.state.Plugins[id] = rec
	}
	if repo, ok := s.backend.(pluginStateBackend); ok {
		if err := repo.savePluginState(s.state.Plugins); err != nil {
			s.loadErr = fmt.Errorf("persist plugin registry: %w", err)
		}
	}
}
func (s *mvpStore) commitPluginLocked(record protocol.PluginRecord) error {
	next := make(map[string]protocol.PluginRecord, len(s.state.Plugins)+1)
	for id, item := range s.state.Plugins {
		next[id] = item
	}
	next[record.ID] = record
	if repo, ok := s.backend.(pluginStateBackend); ok {
		if err := repo.savePluginState(next); err != nil {
			return err
		}
	} else if durable, ok := s.backend.(mvpBlobBackend); ok {
		state := s.state
		state.Plugins = next
		raw, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if err = durable.saveMVPState(raw); err != nil {
			return err
		}
	}
	s.state.Plugins = next
	return nil
}
func pluginPresentation(rec protocol.PluginRecord, role string) protocol.PluginRecord {
	rec = normalizePlugin(rec)
	rec.CanRollback = rec.Source != "builtin" && rec.Previous != nil && rec.Previous.ArtifactDigest != ""
	rec.Actions = []string{}
	if rec.Status == "enabled" {
		rec.Actions = append(rec.Actions, "open")
	}
	if roleAllows(role, "plugin.manage") {
		if rec.Status == "enabled" {
			rec.Actions = append(rec.Actions, "disable")
		} else if rec.Status != "uninstalled" {
			rec.Actions = append(rec.Actions, "enable")
		}
		if rec.Source != "builtin" {
			rec.Actions = append(rec.Actions, "install")
			if rec.Status != "uninstalled" {
				rec.Actions = append(rec.Actions, "uninstall")
			}
			if rec.CanRollback {
				rec.Actions = append(rec.Actions, "rollback")
			}
		}
	}
	return rec
}

type pluginError struct {
	status        int
	code, message string
}

func (e *pluginError) Error() string                    { return e.message }
func failPlugin(status int, code, message string) error { return &pluginError{status, code, message} }
func writePluginError(w http.ResponseWriter, err error) {
	var e *pluginError
	if errors.As(err, &e) {
		writeAPIError(w, e.status, e.code, e.message)
	} else {
		writeAPIError(w, 500, "PLUGIN_STORAGE_ERROR", "插件存储提交失败")
	}
}
func (s *mvpStore) transitionPlugin(id, action string, revision int64) (protocol.PluginRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.state.Plugins[id]
	if !ok {
		return rec, failPlugin(404, "PLUGIN_NOT_FOUND", "插件不存在")
	}
	rec = normalizePlugin(rec)
	if revision != rec.Revision {
		return rec, failPlugin(409, "PLUGIN_REVISION_CONFLICT", "应用状态已改变，请刷新后重试")
	}
	if rec.Source == "builtin" && action != "enable" && action != "disable" {
		return rec, failPlugin(409, "PLUGIN_BUILTIN_MANAGED", "官方应用随主程序更新，仅支持启用和停用")
	}
	switch action {
	case "enable":
		if rec.Status == "uninstalled" {
			return rec, failPlugin(409, "PLUGIN_PACKAGE_REQUIRED", "请先重新安装插件")
		}
		if rec.Source != "builtin" {
			if err := s.verifyPluginResources(rec); err != nil {
				return rec, err
			}
		}
		rec.Status = "enabled"
		rec.Health = "healthy"
		rec.HealthReason = ""
	case "disable":
		rec.Status = "disabled"
	case "uninstall":
		rec.Status = "uninstalled"
	case "rollback":
		if rec.Previous == nil || rec.Previous.ArtifactDigest == "" {
			return rec, failPlugin(409, "PLUGIN_NO_ROLLBACK", "没有可回滚的完整上一版本")
		}
		previous := rec.Previous
		rec.Manifest = previous.Manifest
		rec.Name = previous.Manifest.Name
		rec.Version = previous.Manifest.Version
		rec.APIVersion = previous.Manifest.APIVersion
		rec.Permissions = previous.Manifest.Permissions
		rec.Signature = previous.Signature
		rec.Status = previous.Status
		rec.Source = previous.Source
		rec.ArtifactDigest = previous.ArtifactDigest
		rec.Previous = nil
		rec.Health = "healthy"
		rec.HealthReason = ""
		if err := s.verifyPluginResources(rec); err != nil {
			return rec, err
		}
	default:
		return rec, failPlugin(400, "PLUGIN_INVALID_ACTION", "不支持的插件操作")
	}
	rec.Revision++
	if err := s.commitPluginLocked(rec); err != nil {
		return rec, err
	}
	return rec, nil
}
func (s *mvpStore) managedPlugins(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	items := s.listPlugins()
	for i := range items {
		items[i] = pluginPresentation(items[i], principal.Role)
	}
	writeJSON(w, 200, map[string]interface{}{"items": items, "nextCursor": ""})
}
func (s *mvpStore) managedPluginItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/plugins/"), "/"), "/")
	if len(parts) < 2 {
		writeAPIError(w, 404, "PLUGIN_NOT_FOUND", "插件操作不存在")
		return
	}
	id, action := parts[0], parts[1]
	if action == "content" {
		s.authenticatedPluginContent(w, r, id, strings.Join(parts[2:], "/"))
		return
	}
	if r.Method != "POST" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	if action == "rpc" {
		s.handlePluginRPC(w, r, id)
		return
	}
	if action == "ticket" {
		s.issuePluginTicket(w, r, id)
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	permission := "plugin.manage"
	if action == "install" {
		permission = "plugin.install"
	}
	if !roleAllows(principal.Role, permission) {
		writeAPIError(w, 403, "FORBIDDEN", permission+" permission required")
		return
	}
	var input struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		StageID          string `json:"stageId"`
		ProbeNonce       string `json:"probeNonce"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&input); err != nil {
		writeAPIError(w, 400, "INVALID_REQUEST", "需要插件包或预期修订号")
		return
	}
	var rec protocol.PluginRecord
	var err error
	if action == "install" {
		if input.StageID == "" {
			writeAPIError(w, 400, "PLUGIN_PACKAGE_REQUIRED", "请上传完整 .linkos-plugin 插件包")
			return
		}
		rec, err = s.installStagedPlugin(id, input.StageID, input.ExpectedRevision, input.ProbeNonce, principal)
	} else {
		rec, err = s.transitionPlugin(id, action, input.ExpectedRevision)
	}
	if err != nil {
		writePluginError(w, err)
		return
	}
	s.hub.emit("plugin.updated", pluginPresentation(rec, principal.Role))
	s.recordMutation(r, principal, "plugin."+action, id, rec.Version)
	writeJSON(w, 200, pluginPresentation(rec, principal.Role))
}
