package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

type fileStorageBackend struct {
	memoryBackend
	raw            []byte
	loadErr        error
	loadUploadsErr error
	saveErr        error
	writes         int
}

func (b *fileStorageBackend) loadUploadSessions() ([]uploadSession, error) {
	return nil, b.loadUploadsErr
}

func TestUploadLoadFailureBlocksStartup(t *testing.T) {
	backend := &fileStorageBackend{loadUploadsErr: errors.New("upload table unreadable")}
	store := newUploadStoreWithBackend(t.TempDir(), backend)
	if store.loadErr == nil {
		t.Fatal("unreadable uploads accepted as an empty store")
	}
}

func (b *fileStorageBackend) loadMVPState() ([]byte, error) { return b.raw, b.loadErr }
func (b *fileStorageBackend) saveMVPState(raw []byte) error {
	b.writes++
	if b.saveErr != nil {
		return b.saveErr
	}
	b.raw = append([]byte(nil), raw...)
	return nil
}

func putStorageObject(t *testing.T, content *contentStore, body string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(body))
	hash := hex.EncodeToString(sum[:])
	file := filepath.Join(t.TempDir(), "object")
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := content.commit(file, hash); err != nil {
		t.Fatal(err)
	}
	return hash
}

func TestLegacyCASFreezeSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.db")
	backend, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	content := newContentStore(t.TempDir())
	oldHash := putStorageObject(t, content, "pre-upgrade history")
	store := newMVPStore(backend, newHub())
	if err := store.initializeFileStorage(content); err != nil {
		t.Fatal(err)
	}
	newHash := putStorageObject(t, content, "private new content")
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	backend, err = newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	restarted := newMVPStore(backend, newHub())
	if err := restarted.initializeFileStorage(content); err != nil {
		t.Fatal(err)
	}
	if !restarted.state.LegacyFilesInitialized || !restarted.state.LegacyReadableHashes[oldHash] || restarted.state.LegacyReadableHashes[newHash] {
		t.Fatalf("frozen history changed after restart: %+v", restarted.state.LegacyReadableHashes)
	}
}

func TestLegacyCASMemoryRestartDoesNotExposeNewObjects(t *testing.T) {
	content := newContentStore(t.TempDir())
	oldHash := putStorageObject(t, content, "historical memory-mode content")
	store := newMVPStore(memoryBackend{}, newHub())
	if err := store.initializeFileStorage(content); err != nil {
		t.Fatal(err)
	}
	privateHash := putStorageObject(t, content, "private content after initialization")
	restarted := newMVPStore(memoryBackend{}, newHub())
	if err := restarted.initializeFileStorage(content); err != nil {
		t.Fatal(err)
	}
	if !restarted.state.LegacyReadableHashes[oldHash] || restarted.state.LegacyReadableHashes[privateHash] {
		t.Fatalf("memory restart expanded legacy access: %+v", restarted.state.LegacyReadableHashes)
	}
}

func TestLegacyCASInvalidManifestBlocksStartup(t *testing.T) {
	content := newContentStore(t.TempDir())
	if err := os.WriteFile(filepath.Join(content.root, ".legacy-readable.json"), []byte(`{"initialized":`), 0600); err != nil {
		t.Fatal(err)
	}
	store := newMVPStore(memoryBackend{}, newHub())
	if err := store.initializeFileStorage(content); err == nil || store.state.LegacyFilesInitialized {
		t.Fatal("corrupt historical boundary was accepted or overwritten")
	}
}

func TestLegacyCASFreezeFailureDoesNotPublish(t *testing.T) {
	backend := &fileStorageBackend{}
	store := newMVPStore(backend, newHub())
	before := string(backend.raw)
	content := newContentStore(t.TempDir())
	hash := putStorageObject(t, content, "old content")
	backend.saveErr = errors.New("disk full")
	if err := store.initializeFileStorage(content); err == nil {
		t.Fatal("expected initialization error")
	}
	if store.state.LegacyFilesInitialized || len(store.state.LegacyReadableHashes) != 0 || string(backend.raw) != before {
		t.Fatal("failed freeze published a marker or changed durable state")
	}
	backend.saveErr = nil
	restarted := newMVPStore(backend, newHub())
	if err := restarted.initializeFileStorage(content); err != nil {
		t.Fatal(err)
	}
	if !restarted.state.LegacyReadableHashes[hash] {
		t.Fatal("retry lost historical object")
	}
}

func TestMVPInvalidStateCannotBeOverwritten(t *testing.T) {
	for _, backend := range []*fileStorageBackend{
		{raw: []byte(`{"resources":`)},
		{raw: []byte{}},
		{raw: []byte("null")},
		{loadErr: errors.New("database read failed")},
	} {
		store := newMVPStore(backend, newHub())
		if backend.writes != 0 {
			t.Fatalf("unreadable state overwritten %d times", backend.writes)
		}
		if err := store.initializeFileStorage(newContentStore(t.TempDir())); err == nil {
			t.Fatal("unreadable state allowed writable startup")
		}
	}
}

func TestLegacyCASFreezeScanFailureDoesNotPublish(t *testing.T) {
	store := newMVPStore(&fileStorageBackend{}, newHub())
	content := &contentStore{root: filepath.Join(t.TempDir(), "missing")}
	if err := store.initializeFileStorage(content); err == nil {
		t.Fatal("missing content root must not silently initialize empty history")
	}
	if store.state.LegacyFilesInitialized {
		t.Fatal("failed scan published initialization")
	}
}

func TestFileShareResolvesLogicalEntryAndRange(t *testing.T) {
	store := newMVPStore(memoryBackend{}, newHub())
	content := newContentStore(t.TempDir())
	hash := putStorageObject(t, content, "shared bytes")
	store.contentDownload = content.handleDownload
	store.state.Resources["res_shared"] = protocol.ResourceRecord{ID: "res_shared", Type: "file", Meta: map[string]interface{}{"contentHash": hash}}
	store.state.Shares["one-time"] = protocol.ResourceShareLink{Token: "one-time", ResourceID: "res_shared", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), SingleUse: true}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/shares/one-time/content", nil)
	req.Header.Set("Range", "bytes=0-5")
	rec := httptest.NewRecorder()
	store.handleShare(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "shared" {
		t.Fatalf("logical share: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	store.handleShare(rec, httptest.NewRequest(http.MethodGet, "/api/v1/shares/one-time/content", nil))
	if rec.Code != http.StatusGone {
		t.Fatalf("reused share: %d", rec.Code)
	}
}

func TestFileShareRejectsFolderOrDeletedEntryWithoutConsumption(t *testing.T) {
	for _, resourceType := range []string{"folder", "deleted"} {
		store := newMVPStore(memoryBackend{}, newHub())
		store.contentDownload = func(w http.ResponseWriter, _ *http.Request) { t.Error("invalid entry reached CAS"); w.WriteHeader(200) }
		if resourceType == "folder" {
			store.state.Resources["res_shared"] = protocol.ResourceRecord{ID: "res_shared", Type: "folder"}
		}
		store.state.Shares["token"] = protocol.ResourceShareLink{Token: "token", ResourceID: "res_shared", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), SingleUse: true}
		rec := httptest.NewRecorder()
		store.handleShare(rec, httptest.NewRequest(http.MethodGet, "/api/v1/shares/token/content", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s share: %d", resourceType, rec.Code)
		}
		if store.state.Shares["token"].UsedAt != "" {
			t.Fatal("invalid download consumed token")
		}
	}
}

func TestFileSharePersistenceFailureDoesNotConsume(t *testing.T) {
	backend := &fileStorageBackend{}
	store := newMVPStore(backend, newHub())
	store.state.Resources["folder"] = protocol.ResourceRecord{ID: "folder", Type: "folder"}
	store.state.Shares["token"] = protocol.ResourceShareLink{Token: "token", ResourceID: "folder", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), SingleUse: true}
	backend.saveErr = errors.New("disk full")
	rec := httptest.NewRecorder()
	store.handleShare(rec, httptest.NewRequest(http.MethodGet, "/api/v1/shares/token", nil))
	if rec.Code != http.StatusInternalServerError || store.state.Shares["token"].UsedAt != "" {
		t.Fatalf("failed share consumption: %d", rec.Code)
	}
	var state mvpState
	if err := json.Unmarshal(backend.raw, &state); err != nil {
		t.Fatal(err)
	}
}
