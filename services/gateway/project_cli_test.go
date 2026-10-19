package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func testProject(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]string{"scripts/dev.mjs": "// fixture", "go.work": "go 1.25.0\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writePrivateJSON(filepath.Join(root, "linkos.config.json"), defaultProjectConfig()); err != nil {
		t.Fatal(err)
	}
	return root
}
func TestProjectConfigPrecedencePathsAndLegacyMigration(t *testing.T) {
	root := testProject(t)
	file := filepath.Join(root, "linkos.config.json")
	c := defaultProjectConfig()
	c.Dev.Port = "6001"
	c.Dev.Home = "state with spaces"
	c.Tools.Go = "./tools/custom go"
	writePrivateJSON(file, c)
	t.Setenv("LINKOS_DEV_PORT", "6002")
	o, _, _, err := resolveProject([]string{"dev", "--project", root, "--port", "6003"})
	if err != nil {
		t.Fatal(err)
	}
	if o.Config.Dev.Port != "6003" || o.Config.Dev.Home != filepath.Join(root, "state with spaces") || o.Config.Tools.Go != filepath.Join(root, "tools/custom go") {
		t.Fatalf("wrong resolved options: %+v", o)
	}
	o, _, _, err = resolveProject([]string{"dev", "--project", root, "--web-port", "6004"})
	if err != nil || o.Config.Dev.Port != "6004" {
		t.Fatalf("legacy CLI must override new environment: %+v %v", o, err)
	}
	if _, _, _, err = resolveProject([]string{"dev", "--project", root, "--web-port", "6004", "--gateway-port", "6005"}); err == nil {
		t.Fatal("ambiguous legacy ports accepted")
	}
	o, _, _, err = resolveProject([]string{"dev", "--project", root, "--web-port", "6004", "--gateway-port", "6005", "--port", "6006"})
	if err != nil || o.Config.Dev.Port != "6006" {
		t.Fatal("explicit entry did not resolve legacy conflict", err)
	}
	o, _, _, err = resolveProject([]string{"dev", "--project", root, "--acceptance"})
	if err != nil || !strings.HasSuffix(o.Config.Dev.Home, "acceptance") || o.Config.Dev.HTTPS || o.Config.Dev.Host != "127.0.0.1" {
		t.Fatal("acceptance must be isolated", err)
	}
}
func TestProjectConfigRejectsUnknownInvalidAndTrailingValues(t *testing.T) {
	root := testProject(t)
	file := filepath.Join(root, "linkos.config.json")
	for _, raw := range []string{`{}`, `null`, `{"schemaVersion":1,"dev":null}`, `{"schemaVersion":1,"dev":{"https":null}}`, `{"schemaVersion":2}`, `{"schemaVersion":1,"unknown":true}`, `{"schemaVersion":1,"dev":{"prot":42}}`, `{"schemaVersion":1,"dev":{"port":65536}}`, `{"schemaVersion":1,"dev":{"port":"1e4"}}`, `{"schemaVersion":1,"dev":{"https":"true"}}`, `{"schemaVersion":1,"dev":{"publicHost":"host.test/path"}}`, `{"schemaVersion":1} {}`, `{"schemaVersion":1,"pack":{"targets":["plan9/amd64"]}}`} {
		os.WriteFile(file, []byte(raw), 0600)
		if _, err := loadProjectFile(root, file); err == nil {
			t.Fatalf("invalid config accepted: %s", raw)
		}
	}
}
func TestProjectConfigSetValidationIsAtomic(t *testing.T) {
	root := testProject(t)
	o, _, _, err := resolveProject([]string{"config", "--project", root})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(o.File)
	if err = projectConfigCommand(o, []string{"config", "set", "dev.port", "99999"}); err == nil {
		t.Fatal("invalid write accepted")
	}
	after, _ := os.ReadFile(o.File)
	if string(before) != string(after) {
		t.Fatal("invalid set changed original file")
	}
	if err = projectConfigCommand(o, []string{"config", "set", "dev.port", "9000"}); err != nil {
		t.Fatal(err)
	}
	c, err := loadProjectFile(root, o.File)
	if err != nil || c.Dev.Port != "9000" {
		t.Fatal("valid set not persisted", err)
	}
	if err = projectConfigCommand(o, []string{"config", "set", "dev.typo", "true"}); err == nil {
		t.Fatal("unknown set accepted")
	}
}
func TestDevelopmentProxyIsolationAndFailure(t *testing.T) {
	for _, test := range []struct{ env, url string }{{"production", "http://127.0.0.1:5173"}, {"development", "http://localhost:5173"}, {"development", "https://127.0.0.1:5173"}, {"development", "http://192.168.1.1:5173"}, {"development", "http://127.0.0.1:5173/path"}, {"development", "http://user@127.0.0.1:5173"}} {
		if validateDevUpstream(test.env, test.url) == nil {
			t.Fatal("unsafe upstream accepted", test)
		}
	}
	prior := activeConfig
	defer func() { activeConfig = prior }()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__linkos/dev" {
			writeJSON(w, 200, map[string]string{"projectId": "proxy-test"})
			return
		}
		w.Header().Set("X-Path", r.URL.Path)
		w.Write([]byte("Vite page"))
	}))
	defer upstream.Close()
	activeConfig = runtimeConfig{Environment: "development", DevUpstream: upstream.URL, ProjectID: "proxy-test"}
	if !devUpstreamReady() {
		t.Fatal("upstream not ready")
	}
	handler := webHandler()
	for _, path := range []string{"/", "/src/main.tsx", "/@vite/client"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("X-Path") != path {
			t.Fatal("proxy failed", path, w.Code)
		}
	}
	for _, path := range []string{"/api/unknown", "/__linkos/private"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatal("reserved path leaked to Vite", path)
		}
	}
	upstream.Close()
	if devUpstreamReady() {
		t.Fatal("dead Vite reported ready")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 {
		t.Fatal("missing explicit proxy failure", w.Code)
	}
}
func TestDevelopmentIdentityStaysLocal(t *testing.T) {
	prior := activeConfig
	defer func() { activeConfig = prior }()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"projectId": "private-project"})
	}))
	defer upstream.Close()
	activeConfig = runtimeConfig{Environment: "development", DevUpstream: upstream.URL, ProjectID: "private-project"}
	mux := http.NewServeMux()
	registerDevelopmentRoutes(mux)
	for _, remote := range []string{"127.0.0.1:1234", "192.168.1.23:1234"} {
		request := httptest.NewRequest("GET", "/__linkos/dev", nil)
		request.RemoteAddr = remote
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, request)
		var info map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &info)
		_, exists := info["projectId"]
		if exists != (remote == "127.0.0.1:1234") {
			t.Fatal("identity visibility mismatch", remote)
		}
	}
}
func TestCLIInstallationRejectsUnownedLocations(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "existing"), []byte("keep"), 0600)
	prior := bundledAssets
	bundledAssets = fstest.MapFS{}
	defer func() { bundledAssets = prior }()
	if err := installUserCLI(projectOptions{}, dir); err == nil {
		t.Fatal("unowned nonempty directory accepted")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "existing"))
	if string(raw) != "keep" {
		t.Fatal("existing file changed")
	}
}

func TestDevelopmentStopOnlyControlsItsOwnLauncher(t *testing.T) {
	home := t.TempDir()
	requests := 0
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer private-token" || r.Header.Get("X-LinkOS-Instance") != "owned-instance" {
			t.Error("missing controller identity")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer controller.Close()
	state := developmentControl{LauncherPID: 123, URL: controller.URL, Token: "private-token", InstanceID: "owned-instance"}
	if err := writePrivateJSON(filepath.Join(home, "dev-control.json"), state); err != nil {
		t.Fatal(err)
	}
	if err := stopDevelopment(home, 456); err == nil || requests != 0 {
		t.Fatal("another launcher's service was contacted", err)
	}
	if err := stopDevelopment(home, 123); err != nil || requests != 1 {
		t.Fatal("owned controller was not stopped", err)
	}
}
