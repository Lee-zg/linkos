package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func fixtureManifest(id, version string) protocol.PluginManifest {
	return protocol.PluginManifest{ID: id, Name: "Fixture", Version: version, APIVersion: "1.0", Entry: map[string]string{"ui": "ui/index.html"}, Permissions: []string{"resource.read:code.*", "ui.notify"}, Network: map[string]interface{}{"mode": "deny"}}
}
func fixturePackage(t *testing.T, manifest protocol.PluginManifest, html string, key ed25519.PrivateKey, extra map[string]string) []byte {
	t.Helper()
	raw, _ := json.Marshal(manifest)
	files := map[string][]byte{"manifest.json": raw, "ui/index.html": []byte(html)}
	checks := pluginChecksums{Format: 1}
	for name, data := range files {
		sum := sha256.Sum256(data)
		checks.Files = append(checks.Files, pluginFileHash{Path: name, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])})
	}
	raw, _ = json.Marshal(checks)
	files["checksums.json"] = raw
	if key != nil {
		files["signature.ed25519"] = []byte(hex.EncodeToString(ed25519.Sign(key, raw)))
	}
	for name, data := range extra {
		files[name] = []byte(data)
	}
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, data := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		file.Write(data)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func pluginFixture(t *testing.T, backend persistBackend) (*mvpStore, *authStore, http.Handler, string) {
	t.Helper()
	t.Setenv("LINKOS_DATA_DIR", t.TempDir())
	t.Setenv("LINKOS_ENV", "development")
	t.Setenv("LINKOS_PLUGIN_TRUSTED_KEYS", "")
	auth := newAuthStore("demo", "test-passcode", newAccessPolicy(), newAccessStore())
	h := newHub()
	store := newMVPStore(backend, h)
	if store.loadErr != nil {
		t.Fatal(store.loadErr)
	}
	registerMVPAuth(store, auth)
	mux := http.NewServeMux()
	registerMVPRoutes(mux, auth, store)
	return store, auth, mux, mvpAdminToken(t, auth)
}
func pluginCall(handler http.Handler, token, method, path string, body interface{}) *httptest.ResponseRecorder {
	var raw []byte
	if data, ok := body.([]byte); ok {
		raw = data
	} else if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
func requirePluginCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status || code != "" && !bytes.Contains(rec.Body.Bytes(), []byte(code)) {
		t.Fatalf("status=%d body=%s, want %d/%s", rec.Code, rec.Body.String(), status, code)
	}
}
func installFixture(t *testing.T, handler http.Handler, token string, manifest protocol.PluginManifest, html string) protocol.PluginRecord {
	t.Helper()
	inspect := pluginCall(handler, token, "POST", "/api/v1/plugin-packages/inspect", fixturePackage(t, manifest, html, nil, nil))
	requirePluginCode(t, inspect, 200, "")
	var stage stagedPlugin
	json.Unmarshal(inspect.Body.Bytes(), &stage)
	ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{"stageId": stage.ID})
	requirePluginCode(t, ticket, 200, "")
	var view struct{ Nonce, Src string }
	json.Unmarshal(ticket.Body.Bytes(), &view)
	requirePluginCode(t, pluginCall(handler, "", "GET", view.Src, nil), 200, "")
	installed := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/install", map[string]interface{}{"stageId": stage.ID, "expectedRevision": stage.ExpectedRevision, "probeNonce": view.Nonce})
	requirePluginCode(t, installed, 200, "")
	var result protocol.PluginRecord
	json.Unmarshal(installed.Body.Bytes(), &result)
	return result
}
func TestMVPPluginRollbackRestoresPreviousManifest(t *testing.T) {
	store, _, handler, token := pluginFixture(t, memoryBackend{})
	manifest := fixtureManifest("fixture.reader", "1.0.0")
	first := installFixture(t, handler, token, manifest, "version-one")
	enabled, err := store.transitionPlugin(first.ID, "enable", first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Version = "2.0.0"
	manifest.Permissions = []string{"ui.notify"}
	second := installFixture(t, handler, token, manifest, "version-two")
	if !second.CanRollback || second.Status != "enabled" {
		t.Fatalf("upgrade: %+v", second)
	}
	result := pluginCall(handler, token, "POST", "/api/v1/plugins/"+first.ID+"/rollback", map[string]int64{"expectedRevision": second.Revision})
	requirePluginCode(t, result, 200, "")
	var record protocol.PluginRecord
	json.Unmarshal(result.Body.Bytes(), &record)
	if record.Version != first.Version || record.Status != enabled.Status || !reflect.DeepEqual(record.Permissions, first.Permissions) {
		t.Fatalf("rollback incomplete: %+v", record)
	}
	data, err := store.readManagedPluginAsset(record, "ui/index.html")
	if err != nil || string(data) != "version-one" {
		t.Fatalf("bytes not restored: %s %v", data, err)
	}
	requirePluginCode(t, pluginCall(handler, token, "POST", "/api/v1/plugins/"+first.ID+"/rollback", map[string]int64{"expectedRevision": record.Revision}), 409, "PLUGIN_NO_ROLLBACK")
	if !reflect.DeepEqual(store.state.Plugins[first.ID].Manifest, record.Manifest) {
		t.Fatal("no-rollback mutated record")
	}
}
func TestMVPPluginHealthFailureAutomaticallyRollsBack(t *testing.T) {
	store, _, handler, token := pluginFixture(t, memoryBackend{})
	first := installFixture(t, handler, token, fixtureManifest("fixture.reader", "1.0.0"), "good")
	store.transitionPlugin(first.ID, "enable", first.Revision)
	second := installFixture(t, handler, token, fixtureManifest(first.ID, "2.0.0"), "bad")
	dir, _ := store.packageDirectory(second)
	os.WriteFile(filepath.Join(dir, "ui", "index.html"), []byte("tampered"), 0600)
	if _, err := store.readManagedPluginAsset(second, "ui/index.html"); err == nil {
		t.Fatal("served tampered bytes")
	}
	store.checkPluginHealth()
	rec := store.state.Plugins[first.ID]
	if rec.Version != first.Version || rec.Status != "enabled" || rec.HealthReason == "" || rec.Revision <= second.Revision {
		t.Fatalf("health rollback incomplete: %+v", rec)
	}
}
func TestPluginHealthCheckerDetectsMissingUI(t *testing.T) {
	store, _, handler, token := pluginFixture(t, memoryBackend{})
	rec := installFixture(t, handler, token, fixtureManifest("fixture.reader", "1.0.0"), "good")
	store.transitionPlugin(rec.ID, "enable", rec.Revision)
	dir, _ := store.packageDirectory(rec)
	os.Remove(filepath.Join(dir, "ui", "index.html"))
	store.checkPluginHealth()
	rec = store.state.Plugins[rec.ID]
	if rec.Status != "failed" || rec.HealthReason == "" {
		t.Fatal("missing resources reported healthy")
	}
	os.WriteFile(filepath.Join(dir, "ui", "index.html"), []byte("good"), 0600)
	rec, err := store.transitionPlugin(rec.ID, "enable", rec.Revision)
	if err != nil || rec.Health != "healthy" {
		t.Fatalf("repaired bytes not enabled: %v", err)
	}
}
func TestPluginPackageValidation(t *testing.T) {
	store, _, _, _ := pluginFixture(t, memoryBackend{})
	principal := authPrincipal{Token: "fixture"}
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	t.Setenv("LINKOS_PLUGIN_TRUSTED_KEYS", hex.EncodeToString(pub))
	manifest := fixtureManifest("fixture.reader", "1.0.0")
	t.Setenv("LINKOS_ENV", "production")
	if _, err := store.inspectPackage(fixturePackage(t, manifest, "good", nil, nil), principal); err == nil {
		t.Fatal("production unsigned accepted")
	}
	signed := fixturePackage(t, manifest, "good", key, nil)
	if _, err := store.inspectPackage(signed, principal); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*protocol.PluginManifest){"api": func(m *protocol.PluginManifest) { m.APIVersion = "2.0" }, "service": func(m *protocol.PluginManifest) { m.Entry["service"] = "ui/main.js" }, "network": func(m *protocol.PluginManifest) { m.Network["mode"] = "allow" }, "write": func(m *protocol.PluginManifest) { m.Permissions = []string{"resource.write:*"} }, "builtin": func(m *protocol.PluginManifest) { m.ID = "chat.core" }, "missing": func(m *protocol.PluginManifest) { m.Entry["ui"] = "ui/missing.html" }} {
		t.Run(name, func(t *testing.T) {
			m := fixtureManifest("fixture.reader", "1.0.0")
			change(&m)
			if _, err := store.inspectPackage(fixturePackage(t, m, "good", key, nil), principal); err == nil {
				t.Fatal("unsupported package accepted")
			}
		})
	}
	for _, name := range []string{"../escape", "ui/Index.HTML", "ui/CON.txt", "ui/test.", "ui/evil:stream", "ui/extra.js"} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.inspectPackage(fixturePackage(t, manifest, "good", key, map[string]string{name: "unlisted"}), principal); err == nil {
				t.Fatal("malicious or unlisted file accepted")
			}
		})
	}
	// Signed checksum bytes must match every runtime byte.
	archive, _ := zip.NewReader(bytes.NewReader(signed), int64(len(signed)))
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, file := range archive.File {
		data, _ := readZipFile(file, maxPluginFile)
		if file.Name == "ui/index.html" {
			data = []byte("evil")
		}
		w, _ := zw.Create(file.Name)
		w.Write(data)
	}
	zw.Close()
	if _, err := store.inspectPackage(out.Bytes(), principal); err == nil {
		t.Fatal("tampered signed resource accepted")
	}
}

type failingPluginBackend struct {
	memoryBackend
	fail    bool
	records map[string]protocol.PluginRecord
}

func (b *failingPluginBackend) loadPluginState() (map[string]protocol.PluginRecord, bool, error) {
	return b.records, b.records != nil, nil
}
func (b *failingPluginBackend) savePluginState(records map[string]protocol.PluginRecord) error {
	if b.fail {
		return errors.New("disk unavailable")
	}
	b.records = records
	return nil
}
func TestPluginCommitFailureAndRevisionConflictPreserveVersion(t *testing.T) {
	backend := &failingPluginBackend{}
	store, _, handler, token := pluginFixture(t, backend)
	before := store.state.Plugins["chat.core"]
	backend.fail = true
	requirePluginCode(t, pluginCall(handler, token, "POST", "/api/v1/plugins/chat.core/disable", map[string]int64{"expectedRevision": before.Revision}), 500, "PLUGIN_STORAGE_ERROR")
	if store.state.Plugins[before.ID].Status != before.Status || store.state.Plugins[before.ID].Revision != before.Revision {
		t.Fatal("failed commit changed memory")
	}
	backend.fail = false
	changed, _ := store.transitionPlugin(before.ID, "disable", before.Revision)
	if _, err := store.transitionPlugin(before.ID, "enable", before.Revision); err == nil {
		t.Fatal("stale revision accepted")
	}
	if store.state.Plugins[before.ID].Revision != changed.Revision {
		t.Fatal("conflict changed memory")
	}
	rec := installFixture(t, handler, token, fixtureManifest("fixture.retry", "1.0.0"), "good")
	stage, err := store.inspectPackage(fixturePackage(t, fixtureManifest(rec.ID, "2.0.0"), "next", nil, nil), authPrincipal{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+rec.ID+"/ticket", map[string]string{"stageId": stage.ID})
	var view struct{ Nonce string }
	json.Unmarshal(ticket.Body.Bytes(), &view)
	backend.fail = true
	if _, err = store.installStagedPlugin(rec.ID, stage.ID, rec.Revision, view.Nonce, authPrincipal{Token: token}); err == nil {
		t.Fatal("failed save accepted")
	}
	if store.state.Plugins[rec.ID].Version != "1.0.0" {
		t.Fatal("old version lost")
	}
	backend.fail = false
	next, err := store.installStagedPlugin(rec.ID, stage.ID, rec.Revision, view.Nonce, authPrincipal{Token: token})
	if err != nil || next.Version != "2.0.0" {
		t.Fatalf("retry: %v", err)
	}
}
func TestPluginTicketsRPCAndRoles(t *testing.T) {
	store, auth, handler, token := pluginFixture(t, memoryBackend{})
	rec := installFixture(t, handler, token, fixtureManifest("fixture.reader", "1.0.0"), "good")
	rec, _ = store.transitionPlugin(rec.ID, "enable", rec.Revision)
	requirePluginCode(t, pluginCall(handler, "", "GET", "/api/v1/plugins/"+rec.ID+"/content/ui/index.html", nil), 401, "")
	for _, role := range []string{"member", "guest"} {
		t.Run(role, func(t *testing.T) {
			auth.policy.set(false, true)
			principal, _, code := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: role, AccessType: accessTypeGuest})
			if code != "" {
				t.Fatal(code)
			}
			auth.mu.Lock()
			principal.Role = role
			auth.sessions[principal.Token] = principal
			auth.mu.Unlock()
			for _, action := range []string{"install", "enable", "disable", "uninstall", "rollback"} {
				requirePluginCode(t, pluginCall(handler, principal.Token, "POST", "/api/v1/plugins/"+rec.ID+"/"+action, map[string]int64{"expectedRevision": rec.Revision}), 403, "FORBIDDEN")
			}
			requirePluginCode(t, pluginCall(handler, principal.Token, "POST", "/api/v1/plugin-packages/inspect", []byte("zip")), 403, "FORBIDDEN")
		})
	}
	ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+rec.ID+"/ticket", map[string]string{})
	var view struct{ Nonce, Src string }
	json.Unmarshal(ticket.Body.Bytes(), &view)
	resource := pluginCall(handler, "", "GET", view.Src, nil)
	requirePluginCode(t, resource, 200, "")
	if !strings.Contains(resource.Header().Get("Content-Security-Policy"), "connect-src 'none'") || !strings.Contains(resource.Header().Get("Content-Security-Policy"), "/ui/") {
		t.Fatal("network CSP missing")
	}
	rpc := func(method string, params interface{}) *httptest.ResponseRecorder {
		return pluginCall(handler, token, "POST", "/api/v1/plugins/"+rec.ID+"/rpc", map[string]interface{}{"method": method, "params": params, "expectedRevision": rec.Revision})
	}
	requirePluginCode(t, rpc("auth.currentUser", nil), 200, "")
	requirePluginCode(t, rpc("resources.get", map[string]string{"id": "engineering"}), 403, "PLUGIN_PERMISSION_DENIED")
	requirePluginCode(t, rpc("resources.put", nil), 400, "PLUGIN_METHOD_UNSUPPORTED")
	requirePluginCode(t, pluginCall(handler, token, "POST", "/api/v1/plugins/"+rec.ID+"/rpc", []byte(strings.Repeat("a", 65537))), 400, "PLUGIN_RPC_INVALID")
	store.pluginRuntime.mu.Lock()
	expired := store.pluginRuntime.tickets[view.Nonce]
	expired.expires = time.Now().Add(-time.Minute)
	store.pluginRuntime.tickets[view.Nonce] = expired
	store.pluginRuntime.mu.Unlock()
	requirePluginCode(t, pluginCall(handler, "", "GET", view.Src, nil), 403, "PLUGIN_TICKET_INVALID")
	store.transitionPlugin(rec.ID, "disable", rec.Revision)
	requirePluginCode(t, rpc("auth.currentUser", nil), 409, "PLUGIN_DISABLED")
}
func TestPluginRegistryRestartAndMigration(t *testing.T) {
	directory := t.TempDir()
	db, err := newSQLiteBackend(filepath.Join(directory, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	store, _, handler, token := pluginFixture(t, db)
	rec := installFixture(t, handler, token, fixtureManifest("fixture.persist", "1.0.0"), "one")
	store.transitionPlugin(rec.ID, "enable", rec.Revision)
	rec = installFixture(t, handler, token, fixtureManifest(rec.ID, "2.0.0"), "two")
	db.Close()
	db, err = newSQLiteBackend(filepath.Join(directory, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	next := newMVPStore(db, newHub())
	if next.loadErr != nil {
		t.Fatal(next.loadErr)
	}
	restored := next.state.Plugins[rec.ID]
	if restored.Version != "2.0.0" || restored.Previous == nil || restored.Revision != rec.Revision || restored.Status != "enabled" {
		t.Fatalf("restart lost registry: %+v", restored)
	}
	if err := next.verifyPluginResources(restored); err != nil {
		t.Fatal(err)
	}
}

func TestPluginLegacyMigrationAndCrossDirectoryBackup(t *testing.T) {
	home := t.TempDir()
	config := testRuntimeConfig(home)
	os.MkdirAll(config.UploadDir, 0700)
	file := filepath.Join(config.DataDir, "gateway.db")
	db, err := newSQLiteBackend(file)
	if err != nil {
		t.Fatal(err)
	}
	legacy := map[string]protocol.PluginRecord{"chat.core": {ID: "chat.core", Status: "disabled", Manifest: fixtureManifest("chat.core", "0.1.0")}, "old.reader": {ID: "old.reader", Status: "enabled", Manifest: fixtureManifest("old.reader", "0.1.0")}}
	raw, _ := json.Marshal(map[string]interface{}{"plugins": legacy})
	if err = db.saveMVPState(raw); err != nil {
		t.Fatal(err)
	}
	db.db.Exec("DROP TABLE plugin_registry")
	db.db.Exec("DELETE FROM schema_migrations WHERE version=10")
	db.Close()
	db, err = newSQLiteBackend(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LINKOS_DATA_DIR", config.DataDir)
	t.Setenv("LINKOS_ENV", "development")
	store := newMVPStore(db, newHub())
	if store.state.Plugins["chat.core"].Status != "disabled" || store.state.Plugins["old.reader"].HealthReason == "" {
		t.Fatal("migration lost disabled state or hid missing resources")
	}
	auth := newAuthStore("demo", "test-passcode", newAccessPolicy(), newAccessStore())
	registerMVPAuth(store, auth)
	mux := http.NewServeMux()
	registerMVPRoutes(mux, auth, store)
	token := mvpAdminToken(t, auth)
	rec := installFixture(t, mux, token, fixtureManifest("fixture.backup", "1.0.0"), "original")
	store.transitionPlugin(rec.ID, "enable", rec.Revision)
	rec = installFixture(t, mux, token, fixtureManifest(rec.ID, "2.0.0"), "upgrade")
	// Exercise the collision between configured source plugins and immutable packages.
	config.PluginDir = filepath.Join(home, "official-source")
	os.MkdirAll(config.PluginDir, 0700)
	os.WriteFile(filepath.Join(config.PluginDir, "README"), []byte("source"), 0600)
	db.Close()
	configFile := filepath.Join(home, "linkos.json")
	writePrivateJSON(configFile, config)
	archive := filepath.Join(t.TempDir(), "plugins.tar.gz")
	if err = backupWorkspace(home, configFile, config, archive); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	nextConfig := testRuntimeConfig(target)
	os.MkdirAll(nextConfig.DataDir, 0700)
	if err = restoreWorkspace(target, filepath.Join(target, "linkos.json"), nextConfig, archive, false); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LINKOS_DATA_DIR", nextConfig.DataDir)
	restored, err := newSQLiteBackend(filepath.Join(nextConfig.DataDir, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	next := newMVPStore(restored, newHub())
	record := next.state.Plugins[rec.ID]
	if err = next.verifyPluginResources(record); err != nil {
		t.Fatal(err)
	}
	rolled, err := next.transitionPlugin(record.ID, "rollback", record.Revision)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := next.readManagedPluginAsset(rolled, "ui/index.html")
	if err != nil || string(bytes) != "original" {
		t.Fatal("restored previous resource bytes mismatch")
	}
	// A schema-9 binary must reject the schema-10 registry rather than ignoring it.
	legacyDB, err := sql.Open("sqlite", filepath.Join(nextConfig.DataDir, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer legacyDB.Close()
	var version int
	legacyDB.QueryRow("SELECT MAX(version) FROM schema_migrations").Scan(&version)
	if version != 10 {
		t.Fatal(version)
	}
}

func TestPluginEventsFilterPrivateChatAndAdministrativeEvents(t *testing.T) {
	store, _, _, _ := pluginFixture(t, memoryBackend{})
	rec := protocol.PluginRecord{Permissions: []string{"event.subscribe:*", "resource.read:*"}}
	principal := authPrincipal{UserID: "reader", Role: roleMember}
	store.state.Channels["private"] = protocol.ChatChannel{ID: "private", Kind: "direct", MemberIDs: []string{"other"}}
	store.state.Resources["private"] = protocol.ResourceRecord{ID: "private", Type: "chat.channel", OwnerID: "system"}
	store.state.Messages["private-message"] = protocol.ChatMessage{ID: "private-message", ChannelID: "private"}
	private := store.hub.emit("chat.message.created", map[string]string{"messageId": "private-message"})
	if store.pluginEventAllowedLocked(principal, rec, private.Type, private.EventID) {
		t.Fatal("private channel event leaked")
	}
	administrative := store.hub.emit("access.policy.updated", map[string]string{})
	if store.pluginEventAllowedLocked(principal, rec, administrative.Type, administrative.EventID) {
		t.Fatal("administrative event leaked")
	}
	code := store.hub.emit("code.version.created", map[string]string{"fileId": "code_file_websocket"})
	if !store.pluginEventAllowedLocked(principal, rec, code.Type, code.EventID) {
		t.Fatal("readable code event dropped")
	}
	if store.pluginEventAllowedLocked(principal, rec, code.Type, "forged") {
		t.Fatal("forged event accepted")
	}
}

func TestFullBackupRestoresPluginTrustWithoutConfiguredSourceDirectory(t *testing.T) {
	home := t.TempDir()
	config := testRuntimeConfig(home)
	config.PluginTrustedKeys = strings.Repeat("a", 64)
	os.MkdirAll(config.UploadDir, 0700)
	db, err := newSQLiteBackend(filepath.Join(config.DataDir, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	file := filepath.Join(home, "linkos.json")
	writePrivateJSON(file, config)
	archive := filepath.Join(t.TempDir(), "trust.tar.gz")
	if err = backupWorkspace(home, file, config, archive); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	next := testRuntimeConfig(target)
	os.MkdirAll(next.DataDir, 0700)
	targetFile := filepath.Join(target, "linkos.json")
	if err = restoreWorkspace(target, targetFile, next, archive, false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatal(err)
	}
	var restored runtimeConfig
	json.Unmarshal(raw, &restored)
	if restored.PluginTrustedKeys != config.PluginTrustedKeys {
		t.Fatal("plugin trust configuration lost during restore")
	}
}
