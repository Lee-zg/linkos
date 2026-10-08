package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func newMVPTestServer(t *testing.T) (*httptest.Server, *authStore) {
	t.Helper()
	auth := newAuthStore("demo", "test-passcode", newAccessPolicy(), newAccessStore())
	h := newHub()
	store := newMVPStore(memoryBackend{}, h)
	registerMVPAuth(store, auth)
	mux := http.NewServeMux()
	registerMVPRoutes(mux, auth, store)
	handleJobRoutes(mux, auth, store)
	return httptest.NewServer(mux), auth
}

func mvpAdminToken(t *testing.T, auth *authStore) string {
	t.Helper()
	principal, _, code := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "管理员", AccessType: accessTypeLogin, Passcode: "test-passcode"})
	if code != "" {
		t.Fatalf("issue admin: %s", code)
	}
	return principal.Token
}

func TestMVPChatMessageQueryAndEdit(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	request := func(method, path string, body interface{}) *httptest.ResponseRecorder {
		var raw bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&raw).Encode(body)
		}
		req := httptest.NewRequest(method, path, &raw)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		server.Config.Handler.ServeHTTP(rec, req)
		return rec
	}
	accepted := request(http.MethodPost, "/api/v1/messages", map[string]interface{}{"body": "hello", "channelId": "engineering", "clientMsgId": "mvp-1"})
	if accepted.Code != http.StatusCreated {
		t.Fatalf("create message status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	var result map[string]interface{}
	_ = json.Unmarshal(accepted.Body.Bytes(), &result)
	id, _ := result["messageId"].(string)
	if id == "" {
		t.Fatal("missing message id")
	}
	list := request(http.MethodGet, "/api/v1/channels/engineering/messages", nil)
	if list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte("hello")) {
		t.Fatalf("message list status=%d body=%s", list.Code, list.Body.String())
	}
	edited := request(http.MethodPatch, "/api/v1/messages/"+id, map[string]string{"body": "edited"})
	if edited.Code != http.StatusOK || !bytes.Contains(edited.Body.Bytes(), []byte("edited")) {
		t.Fatalf("edit status=%d body=%s", edited.Code, edited.Body.String())
	}
	deleted := request(http.MethodDelete, "/api/v1/messages/"+id, nil)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
}

func TestMVPCounterpartCodeSaveConflict(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	get := httptest.NewRequest(http.MethodGet, "/api/v1/code/projects/project_gateway", nil)
	get.Header.Set("Authorization", "Bearer "+token)
	getRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(getRec, get)
	if getRec.Code != http.StatusOK {
		t.Fatalf("files status=%d", getRec.Code)
	}
	var page struct {
		Items []struct{ ID, Version string } `json:"items"`
	}
	_ = json.Unmarshal(getRec.Body.Bytes(), &page)
	if len(page.Items) == 0 {
		t.Fatal("expected seeded code file")
	}
	file := page.Items[0]
	body, _ := json.Marshal(map[string]string{"content": "package changed\n", "baseVersion": file.Version})
	save := httptest.NewRequest(http.MethodPost, "/api/v1/code/files/"+file.ID+"/save", bytes.NewReader(body))
	save.Header.Set("Authorization", "Bearer "+token)
	saveRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(saveRec, save)
	if saveRec.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", saveRec.Code, saveRec.Body.String())
	}
	stale, _ := json.Marshal(map[string]string{"content": "stale", "baseVersion": file.Version})
	conflict := httptest.NewRequest(http.MethodPost, "/api/v1/code/files/"+file.ID+"/save", bytes.NewReader(stale))
	conflict.Header.Set("Authorization", "Bearer "+token)
	conflictRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(conflictRec, conflict)
	if conflictRec.Code != http.StatusConflict || !bytes.Contains(conflictRec.Body.Bytes(), []byte("RESOURCE_VERSION_MISMATCH")) {
		t.Fatalf("conflict status=%d body=%s", conflictRec.Code, conflictRec.Body.String())
	}
}

func TestMVPJobLifecycleAndCancel(t *testing.T) {
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/jobs":
			writeJSON(w, http.StatusAccepted, map[string]string{"id": "job_1", "status": "queued", "runnerId": "runner-test"})
		case r.Method == http.MethodPost && r.URL.Path == "/jobs/job_1/cancel":
			writeJSON(w, http.StatusOK, map[string]string{"id": "job_1", "status": "canceled"})
		default:
			writeJSON(w, http.StatusOK, map[string]interface{}{"id": "job_1", "status": "running", "logs": []string{}})
		}
	}))
	defer runner.Close()
	t.Setenv("LINKOS_RUNNER_URL", runner.URL)
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	body, _ := json.Marshal(map[string]interface{}{"projectId": "project_gateway", "command": "go test ./...", "timeoutSeconds": 1, "memoryMb": 64, "network": "deny"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("job status=%d body=%s", rec.Code, rec.Body.String())
	}
	var job map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &job)
	id, _ := job["id"].(string)
	if id == "" {
		t.Fatal("missing job id")
	}
	cancel := httptest.NewRequest(http.MethodPost, "/api/v1/jobs/"+id+"/cancel", nil)
	cancel.Header.Set("Authorization", "Bearer "+token)
	cancelRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(cancelRec, cancel)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("cancel status=%d body=%s", cancelRec.Code, cancelRec.Body.String())
	}
}

func TestMVPJobRejectsWhenRunnerIsNotConfigured(t *testing.T) {
	t.Setenv("LINKOS_RUNNER_URL", "")
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	body, _ := json.Marshal(map[string]interface{}{"projectId": "project_gateway", "command": "go test ./...", "timeoutSeconds": 1, "memoryMb": 64, "network": "deny"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !bytes.Contains(rec.Body.Bytes(), []byte("RUNNER_UNAVAILABLE")) || !bytes.Contains(rec.Body.Bytes(), []byte("traceId")) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSQLiteMVPMessageSearchUsesFTS(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	store := newMVPStore(backend, newHub())
	store.addMessage(protocol.ChatMessage{ID: "msg_fts_1", ChannelID: "engineering", AuthorID: "usr_1", AuthorName: "Alice", Body: "distributed tracing baseline", CreatedAt: time.Now().UTC().Format(time.RFC3339), Version: 1})
	store.addMessage(protocol.ChatMessage{ID: "msg_fts_2", ChannelID: "engineering", AuthorID: "usr_2", AuthorName: "Bob", Body: "unrelated release note", CreatedAt: time.Now().UTC().Add(time.Second).Format(time.RFC3339), Version: 1})
	items, _ := store.listMessagesFiltered("engineering", "", "trac", "", "", "", 50)
	if len(items) != 1 || items[0].ID != "msg_fts_1" {
		t.Fatalf("unexpected FTS result: %+v", items)
	}
}

func TestMVPPluginLifecycle(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/chat.core/disable", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"status":"disabled"`)) {
		t.Fatalf("disable status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMVPResourceMetadataAndSingleUseShare(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	request := func(method, path string, body interface{}, bearer bool) *httptest.ResponseRecorder {
		var raw bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&raw).Encode(body)
		}
		req := httptest.NewRequest(method, path, &raw)
		if bearer {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		server.Config.Handler.ServeHTTP(rec, req)
		return rec
	}
	created := request(http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "shared"}, true)
	if created.Code != http.StatusCreated {
		t.Fatalf("resource create status=%d body=%s", created.Code, created.Body.String())
	}
	var resource protocol.ResourceRecord
	if err := json.Unmarshal(created.Body.Bytes(), &resource); err != nil || resource.ID == "" {
		t.Fatalf("resource response=%s", created.Body.String())
	}
	patched := request(http.MethodPatch, "/api/v1/resources/"+resource.ID, map[string]interface{}{"meta": map[string]interface{}{"color": "blue"}}, true)
	if patched.Code != http.StatusOK || !bytes.Contains(patched.Body.Bytes(), []byte("blue")) {
		t.Fatalf("resource patch status=%d body=%s", patched.Code, patched.Body.String())
	}
	shared := request(http.MethodPost, "/api/v1/resources/"+resource.ID+"/share", map[string]int{"ttlSeconds": 60}, true)
	if shared.Code != http.StatusCreated {
		t.Fatalf("share status=%d body=%s", shared.Code, shared.Body.String())
	}
	var link protocol.ResourceShareLink
	_ = json.Unmarshal(shared.Body.Bytes(), &link)
	if link.Token == "" || !link.SingleUse {
		t.Fatalf("invalid share=%s", shared.Body.String())
	}
	first := request(http.MethodGet, "/api/v1/shares/"+link.Token, nil, false)
	if first.Code != http.StatusOK {
		t.Fatalf("share read status=%d body=%s", first.Code, first.Body.String())
	}
	second := request(http.MethodGet, "/api/v1/shares/"+link.Token, nil, false)
	if second.Code != http.StatusGone {
		t.Fatalf("share reuse status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestMVPPluginRollbackRestoresPreviousManifest(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	previousVersion := mvpPluginVersion(t, server, token, "chat.core")
	manifest := protocol.PluginManifest{ID: "chat.core", Name: "Chat Next", Version: "2.0.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/v2.js"}, Permissions: []string{"chat.read"}}
	raw, _ := json.Marshal(map[string]interface{}{"manifest": manifest})
	install := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/chat.core/install", bytes.NewReader(raw))
	install.Header.Set("Authorization", "Bearer "+token)
	installRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(installRec, install)
	if installRec.Code != http.StatusCreated {
		t.Fatalf("install status=%d body=%s", installRec.Code, installRec.Body.String())
	}
	rollback := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/chat.core/rollback", nil)
	rollback.Header.Set("Authorization", "Bearer "+token)
	rollbackRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rollbackRec, rollback)
	if rollbackRec.Code != http.StatusOK || !bytes.Contains(rollbackRec.Body.Bytes(), []byte(`"version":"`+previousVersion+`"`)) {
		t.Fatalf("rollback status=%d body=%s", rollbackRec.Code, rollbackRec.Body.String())
	}
}

func TestMVPPluginHealthFailureAutomaticallyRollsBack(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)
	previousVersion := mvpPluginVersion(t, server, token, "chat.core")
	manifest := protocol.PluginManifest{ID: "chat.core", Name: "Chat Broken", Version: "2.0.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/v2.js"}, Permissions: []string{"chat.read"}}
	raw, _ := json.Marshal(map[string]interface{}{"manifest": manifest})
	install := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/chat.core/install", bytes.NewReader(raw))
	install.Header.Set("Authorization", "Bearer "+token)
	installRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(installRec, install)
	if installRec.Code != http.StatusCreated {
		t.Fatalf("install status=%d body=%s", installRec.Code, installRec.Body.String())
	}
	fail := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/chat.core/health-failed", nil)
	fail.Header.Set("Authorization", "Bearer "+token)
	failRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(failRec, fail)
	if failRec.Code != http.StatusOK || !bytes.Contains(failRec.Body.Bytes(), []byte(`"version":"`+previousVersion+`"`)) || !bytes.Contains(failRec.Body.Bytes(), []byte(`"health":"degraded"`)) {
		t.Fatalf("health failure did not roll back: status=%d body=%s", failRec.Code, failRec.Body.String())
	}
}

func mvpPluginVersion(t *testing.T, server *httptest.Server, token, id string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	var result struct {
		Items []protocol.PluginRecord `json:"items"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &result) != nil {
		t.Fatal("cannot capture previous plugin version")
	}
	for _, item := range result.Items {
		if item.ID == id {
			return item.Version
		}
	}
	t.Fatal("plugin not found")
	return ""
}

func TestMVPPluginRollbackResetsHealth(t *testing.T) {
	store := newMVPStore(memoryBackend{}, newHub())
	original := protocol.PluginManifest{ID: "chat.core", Name: "Chat", Version: "0.1.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/chat.js"}, Permissions: []string{"chat.read"}}
	store.state.Plugins["chat.core"] = protocol.PluginRecord{
		ID: "chat.core", Name: "Chat", Version: "2.0.0", Status: "installed",
		Health: "degraded", Manifest: original,
		Previous: &protocol.PluginPrevious{Manifest: original, Status: "enabled"},
	}

	result, ok := store.setPluginStatus("chat.core", "rollback")
	if !ok {
		t.Fatal("setPluginStatus returned false")
	}
	if result.Version != "0.1.0" {
		t.Fatalf("expected version 0.1.0, got %s", result.Version)
	}
	if result.Health != "healthy" {
		t.Fatalf("expected health healthy after rollback, got %s", result.Health)
	}
}

func TestPluginContentServesFile(t *testing.T) {
	pluginDir := t.TempDir()
	chatDir := filepath.Join(pluginDir, "chat")
	uiDir := filepath.Join(chatDir, "ui")
	if err := os.MkdirAll(uiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := protocol.PluginManifest{ID: "chat.core", Name: "Chat", Version: "0.1.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/index.html"}, Permissions: []string{"chat.read"}}
	manifestRaw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(chatDir, "manifest.json"), manifestRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	htmlContent := "<!DOCTYPE html><html><body>Chat Plugin</body></html>"
	if err := os.WriteFile(filepath.Join(uiDir, "index.html"), []byte(htmlContent), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("LINKOS_PLUGIN_DIR", pluginDir)
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins/chat.core/content/ui/index.html", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("content status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("Chat Plugin")) {
		t.Fatalf("content body=%s", rec.Body.String())
	}
}

func TestPluginContentBlocksTraversal(t *testing.T) {
	pluginDir := t.TempDir()
	chatDir := filepath.Join(pluginDir, "chat")
	uiDir := filepath.Join(chatDir, "ui")
	if err := os.MkdirAll(uiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := protocol.PluginManifest{ID: "chat.core", Name: "Chat", Version: "0.1.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/index.html"}, Permissions: []string{"chat.read"}}
	manifestRaw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(chatDir, "manifest.json"), manifestRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uiDir, "index.html"), []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("LINKOS_PLUGIN_DIR", pluginDir)
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins/chat.core/content/../../../etc/passwd", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK && bytes.Contains(rec.Body.Bytes(), []byte("root:")) {
		t.Fatal("path traversal succeeded — security vulnerability")
	}
}

func TestMVPRunnerRegistrationCredentialLifecycle(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	adminToken := mvpAdminToken(t, auth)
	request := func(method, path string, body []byte, bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		server.Config.Handler.ServeHTTP(rec, req)
		return rec
	}
	tokenResponse := request(http.MethodPost, "/api/v1/runners/registration-tokens", nil, adminToken)
	if tokenResponse.Code != http.StatusCreated {
		t.Fatalf("registration token status=%d body=%s", tokenResponse.Code, tokenResponse.Body.String())
	}
	var registrationToken struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(tokenResponse.Body.Bytes(), &registrationToken) != nil || registrationToken.Token == "" {
		t.Fatalf("invalid registration token response=%s", tokenResponse.Body.String())
	}
	runnerBody, _ := json.Marshal(protocol.RunnerInfo{ID: "runner-lifecycle", Platform: "container", Version: "0.1.0", Capabilities: []string{"network-deny"}, Labels: map[string]string{}})
	register := httptest.NewRequest(http.MethodPost, "/api/v1/runners/register", bytes.NewReader(runnerBody))
	register.Header.Set("X-Runner-Token", registrationToken.Token)
	registerRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(registerRec, register)
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("runner register status=%d body=%s", registerRec.Code, registerRec.Body.String())
	}
	var registered struct {
		Runner     protocol.RunnerInfo `json:"runner"`
		Credential string              `json:"credential"`
	}
	if json.Unmarshal(registerRec.Body.Bytes(), &registered) != nil || registered.Credential == "" || registered.Runner.CredentialVersion != 1 {
		t.Fatalf("invalid runner registration response=%s", registerRec.Body.String())
	}
	replay := httptest.NewRequest(http.MethodPost, "/api/v1/runners/register", bytes.NewReader(runnerBody))
	replay.Header.Set("X-Runner-Token", registrationToken.Token)
	replayRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(replayRec, replay)
	if replayRec.Code != http.StatusUnauthorized {
		t.Fatalf("registration token was reusable: status=%d body=%s", replayRec.Code, replayRec.Body.String())
	}
	heartbeatBody, _ := json.Marshal(map[string]string{"id": "runner-lifecycle", "status": "online"})
	heartbeat := httptest.NewRequest(http.MethodPost, "/api/v1/runners/heartbeat", bytes.NewReader(heartbeatBody))
	heartbeat.Header.Set("X-Runner-Credential", registered.Credential)
	heartbeatRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(heartbeatRec, heartbeat)
	if heartbeatRec.Code != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", heartbeatRec.Code, heartbeatRec.Body.String())
	}
	rotate := request(http.MethodPost, "/api/v1/runners/runner-lifecycle/rotate-token", nil, adminToken)
	if rotate.Code != http.StatusOK {
		t.Fatalf("rotate status=%d body=%s", rotate.Code, rotate.Body.String())
	}
	var rotated struct {
		Credential string `json:"credential"`
	}
	_ = json.Unmarshal(rotate.Body.Bytes(), &rotated)
	if rotated.Credential == "" || rotated.Credential == registered.Credential {
		t.Fatal("rotation did not issue a new credential")
	}
	oldHeartbeat := httptest.NewRequest(http.MethodPost, "/api/v1/runners/heartbeat", bytes.NewReader(heartbeatBody))
	oldHeartbeat.Header.Set("X-Runner-Credential", registered.Credential)
	oldRec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(oldRec, oldHeartbeat)
	if oldRec.Code != http.StatusUnauthorized {
		t.Fatalf("old credential remained valid after rotation: %d", oldRec.Code)
	}
	revoke := request(http.MethodPost, "/api/v1/runners/runner-lifecycle/revoke", nil, adminToken)
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revoke.Code, revoke.Body.String())
	}
	deleteResponse := request(http.MethodDelete, "/api/v1/runners/runner-lifecycle", nil, adminToken)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
}

func TestPluginHealthCheckerDetectsMissingUI(t *testing.T) {
	tmpDir := t.TempDir()
	chatDir := filepath.Join(tmpDir, "chat")
	if err := os.MkdirAll(filepath.Join(chatDir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chatDir, "manifest.json"), []byte(`{"id":"chat.core"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LINKOS_PLUGIN_DIR", tmpDir)

	store := newMVPStore(memoryBackend{}, newHub())
	store.state.Plugins["chat.core"] = protocol.PluginRecord{
		ID:     "chat.core",
		Name:   "Chat",
		Status: "enabled",
		Health: "healthy",
		Manifest: protocol.PluginManifest{
			ID:    "chat.core",
			Name:  "Chat",
			Entry: map[string]string{"ui": "ui/index.html"},
		},
	}

	store.checkPluginHealth()
	store.mu.RLock()
	rec := store.state.Plugins["chat.core"]
	store.mu.RUnlock()
	if rec.Health != "degraded" {
		t.Fatalf("expected degraded when UI file missing, got %s", rec.Health)
	}

	if err := os.WriteFile(filepath.Join(chatDir, "ui", "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	store.checkPluginHealth()
	store.mu.RLock()
	rec = store.state.Plugins["chat.core"]
	store.mu.RUnlock()
	if rec.Health != "healthy" {
		t.Fatalf("expected healthy after UI file restored, got %s", rec.Health)
	}
}

func TestPluginManifestSignatureVerification(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := protocol.PluginManifest{ID: "example.signed", Name: "Signed", Version: "1.0.0", APIVersion: "1.0", Entry: map[string]string{"ui": "ui/index.js"}, Permissions: []string{"resource.read"}}
	raw, _ := json.Marshal(manifest)
	signature := base64.RawStdEncoding.EncodeToString(ed25519.Sign(privateKey, raw))
	if !verifyPluginSignature(manifest, signature, []ed25519.PublicKey{publicKey}) {
		t.Fatal("valid signature was rejected")
	}
	manifest.Version = "1.0.1"
	if verifyPluginSignature(manifest, signature, []ed25519.PublicKey{publicKey}) {
		t.Fatal("tampered manifest was accepted")
	}
}
