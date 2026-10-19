package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/x509"
	"database/sql"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func testRuntimeConfig(home string) runtimeConfig {
	c := defaultConfig(home)
	c.Environment = "development"
	c.AdminPasscode = randomSecret()
	return c
}
func TestConfigPrecedenceAndPaths(t *testing.T) {
	home := t.TempDir()
	c := testRuntimeConfig(home)
	c.DataDir = "relative"
	file := filepath.Join(home, "linkos.json")
	if e := writePrivateJSON(file, c); e != nil {
		t.Fatal(e)
	}
	t.Setenv("LINKOS_LISTEN", "127.0.0.1:9998")
	result, e := readRuntimeConfig(home, file, map[string]string{"LINKOS_LISTEN": "127.0.0.1:9999"})
	if e != nil {
		t.Fatal(e)
	}
	if result.Listen != "127.0.0.1:9999" || result.DataDir != filepath.Join(home, "relative") {
		t.Fatal(result)
	}
	c.TLSMode = "local"
	c.Listen = "0.0.0.0:8787"
	if c.validate() == nil {
		t.Fatal("insecure LAN accepted")
	}
}
func TestDataLockRejectsConcurrentWriter(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	first, e := acquireDataLock(dir)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := acquireDataLock(dir); e == nil {
		second.Close()
		t.Fatal("second writer acquired lock")
	}
	first.Close()
	second, e := acquireDataLock(dir)
	if e != nil {
		t.Fatal(e)
	}
	second.Close()
}
func TestTLSRenewKeepsTrustRoot(t *testing.T) {
	home := t.TempDir()
	if e := createLANCertificates(home, "192.168.1.20"); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(filepath.Join(home, "tls", "ca.crt"))
	if e := createLANCertificates(home, "192.168.1.21"); e != nil {
		t.Fatal(e)
	}
	after, _ := os.ReadFile(filepath.Join(home, "tls", "ca.crt"))
	if string(before) != string(after) {
		t.Fatal("renewal changed CA")
	}
	raw, _ := os.ReadFile(filepath.Join(home, "tls", "server.crt"))
	block, _ := pem.Decode(raw)
	leaf, e := x509.ParseCertificate(block.Bytes)
	if e != nil || leaf.VerifyHostname("192.168.1.21") != nil {
		t.Fatal("SAN not renewed")
	}
}
func TestDevelopmentTLSCoversAdaptersWithoutChangingGateway(t *testing.T) {
	home := t.TempDir()
	config := []byte("existing Gateway config must stay untouched")
	file := filepath.Join(home, "linkos.json")
	if err := os.WriteFile(file, config, 0600); err != nil {
		t.Fatal(err)
	}
	priorHome := activeHome
	defer func() { activeHome = priorHome }()
	for _, hosts := range []string{"192.168.1.20,10.0.0.4", "192.168.1.21,10.0.0.4"} {
		if err := runtimeCLI([]string{"tls", "dev", "--home", home, "--host", hosts}); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(home, "dev-web", "tls", "server.crt"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"192.168.1.21", "10.0.0.4", "localhost", "127.0.0.1", "::1"} {
		if err := leaf.VerifyHostname(address); err != nil {
			t.Fatal(err)
		}
	}
	if leaf.VerifyHostname("192.168.1.20") == nil {
		t.Fatal("stale adapter remained in renewed certificate")
	}
	after, err := os.ReadFile(file)
	if err != nil || string(after) != string(config) {
		t.Fatal("Gateway config changed")
	}
	for _, hosts := range []string{"", "0.0.0.0", "224.0.0.1", "bad host.example"} {
		if runtimeCLI([]string{"tls", "dev", "--home", home, "--host", hosts}) == nil {
			t.Fatal("invalid development address accepted")
		}
	}
}
func TestEmbeddedSPAFallbackAndAssets(t *testing.T) {
	prior := bundledAssets
	defer func() { bundledAssets = prior }()
	bundledAssets = fstest.MapFS{"bundle/web/index.html": {Data: []byte("<html>workspace</html>")}, "bundle/web/assets/test.js": {Data: []byte("test")}}
	handler := webHandler()
	for _, item := range []struct {
		url    string
		status int
	}{{"/files", 200}, {"/api/unknown", 404}, {"/missing.js", 404}, {"/assets/test.js", 200}} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, item.url, nil))
		if w.Code != item.status {
			t.Fatalf("%s: %d", item.url, w.Code)
		}
	}
}
func TestCompleteBackupRestoresFilesAndUploadPaths(t *testing.T) {
	source := t.TempDir()
	c := testRuntimeConfig(source)
	os.MkdirAll(c.UploadDir, 0700)
	db, e := newSQLiteBackend(filepath.Join(c.DataDir, "gateway.db"))
	if e != nil {
		t.Fatal(e)
	}
	dir := filepath.Join(c.UploadDir, "up_resume")
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "0.part"), []byte("part"), 0600)
	object := filepath.Join(c.UploadDir, "objects", "aa", "aabb.bin")
	os.MkdirAll(filepath.Dir(object), 0700)
	os.WriteFile(object, []byte("file bytes"), 0600)
	if e = db.saveUploadSession(uploadSession{id: "up_resume", directory: dir, received: map[int]int64{0: 4}, status: "uploading", completedPath: object}); e != nil {
		t.Fatal(e)
	}
	db.Close()
	config := filepath.Join(source, "linkos.json")
	writePrivateJSON(config, c)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if e = backupWorkspace(source, config, c, archive); e != nil {
		t.Fatal(e)
	}
	target := t.TempDir()
	next := testRuntimeConfig(target)
	os.MkdirAll(next.DataDir, 0700)
	if e = restoreWorkspace(target, filepath.Join(target, "linkos.json"), next, archive, false); e != nil {
		t.Fatal(e)
	}
	bytes, e := os.ReadFile(filepath.Join(next.UploadDir, "objects", "aa", "aabb.bin"))
	if e != nil || string(bytes) != "file bytes" {
		t.Fatalf("file missing: %s %v", bytes, e)
	}
	db, e = newSQLiteBackend(filepath.Join(next.DataDir, "gateway.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	sessions, e := db.loadUploadSessions()
	if e != nil || len(sessions) != 1 || sessions[0].directory != filepath.Join(next.UploadDir, "up_resume") {
		t.Fatalf("paths not rebased: %+v %v", sessions, e)
	}
	if e = restoreWorkspace(target, filepath.Join(target, "linkos.json"), next, archive, false); e == nil {
		t.Fatal("existing database replaced without --replace")
	}
}
func TestTamperedArchiveRejectedBeforeReplacement(t *testing.T) {
	source := t.TempDir()
	c := testRuntimeConfig(source)
	os.MkdirAll(c.UploadDir, 0700)
	db, e := newSQLiteBackend(filepath.Join(c.DataDir, "gateway.db"))
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	archive := filepath.Join(t.TempDir(), "good.tar.gz")
	if e = backupWorkspace(source, "", c, archive); e != nil {
		t.Fatal(e)
	}
	bad := filepath.Join(t.TempDir(), "bad.tar.gz")
	in, _ := os.Open(archive)
	defer in.Close()
	zip, _ := gzip.NewReader(in)
	defer zip.Close()
	reader := tar.NewReader(zip)
	out, _ := os.Create(bad)
	writerZip := gzip.NewWriter(out)
	writer := tar.NewWriter(writerZip)
	for {
		h, e := reader.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		writer.WriteHeader(h)
		data, _ := io.ReadAll(reader)
		if h.Name == "linkos.json" {
			data[0] ^= 1
		}
		writer.Write(data)
	}
	writer.Close()
	writerZip.Close()
	out.Close()
	if _, e = extractWorkspace(bad, t.TempDir()); e == nil {
		t.Fatal("tampered config accepted")
	}
}
func TestNewerDatabaseRefusesRollback(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "gateway.db")
	db, e := newSQLiteBackend(file)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.db.Exec("INSERT INTO schema_migrations(version) VALUES (?)", len(sqliteMigrations)+1)
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	if newer, e := newSQLiteBackend(file); e == nil {
		newer.Close()
		t.Fatal("newer database accepted")
	}
	if validateBackupFile(file) == nil {
		t.Fatal("newer backup accepted")
	}
}

func TestCompatibleOldBackupMigratesOnlyStagedDatabase(t *testing.T) {
	source := t.TempDir()
	c := testRuntimeConfig(source)
	os.MkdirAll(c.DataDir, 0700)
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "gateway.db"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)"); e != nil {
		t.Fatal(e)
	}
	for _, statement := range sqliteMigrations[0] {
		if _, e = db.Exec(statement); e != nil {
			t.Fatal(e)
		}
	}
	db.Exec("INSERT INTO schema_migrations(version) VALUES(1)")
	db.Close()
	archive := filepath.Join(t.TempDir(), "old.tar.gz")
	if e = backupWorkspace(source, "", c, archive); e != nil {
		t.Fatal(e)
	}
	target := t.TempDir()
	next := testRuntimeConfig(target)
	os.MkdirAll(next.DataDir, 0700)
	if e = restoreWorkspace(target, filepath.Join(target, "linkos.json"), next, archive, false); e != nil {
		t.Fatal(e)
	}
	v, e := databaseVersion(filepath.Join(next.DataDir, "gateway.db"))
	if e != nil || v != len(sqliteMigrations) {
		t.Fatalf("staged migration failed: %d %v", v, e)
	}
	v, e = databaseVersion(filepath.Join(c.DataDir, "gateway.db"))
	if e != nil || v != 1 {
		t.Fatal("restore changed source database")
	}
}
