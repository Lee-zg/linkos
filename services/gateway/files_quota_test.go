package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeCommitTemp(t *testing.T, data []byte) (string, string) {
	t.Helper()
	tmp, err := os.CreateTemp(t.TempDir(), "cas-commit-*")
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	if _, err := tmp.Write(data); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatalf("close temp: %v", err)
	}
	sum := sha256.Sum256(data)
	return tmp.Name(), hex.EncodeToString(sum[:])
}

func mustCommitObject(t *testing.T, store *contentStore, data []byte) (string, string) {
	t.Helper()
	tmp, hash := writeCommitTemp(t, data)
	path, err := store.commit(tmp, hash)
	if err != nil {
		t.Fatalf("commit object: %v", err)
	}
	return hash, path
}

func mustChtimes(t *testing.T, path string, modTime time.Time) {
	t.Helper()
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func countObjects(t *testing.T, store *contentStore) int {
	t.Helper()
	count := 0
	err := filepath.WalkDir(store.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			count++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk objects: %v", err)
	}
	return count
}

func TestCASCommitEvictsOldestWhenQuotaExceeded(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 100)
	hashA, pathA := mustCommitObject(t, store, bytes.Repeat([]byte("a"), 40))
	_, pathB := mustCommitObject(t, store, bytes.Repeat([]byte("b"), 40))
	past := time.Now().Add(-2 * time.Hour)
	mustChtimes(t, pathA, past)
	mustChtimes(t, pathB, past.Add(time.Hour))

	hashC, _ := mustCommitObject(t, store, bytes.Repeat([]byte("c"), 40))

	if _, err := os.Stat(pathA); !os.IsNotExist(err) {
		t.Fatalf("expected oldest object %s to be evicted, stat err=%v", hashA, err)
	}
	if _, err := os.Stat(pathB); err != nil {
		t.Fatalf("expected newer object to survive, stat err=%v", err)
	}
	if _, err := os.Stat(store.objectPath(hashC)); err != nil {
		t.Fatalf("expected committed object to exist, stat err=%v", err)
	}
	if got := countObjects(t, store); got != 2 {
		t.Fatalf("expected 2 objects after eviction, got %d", got)
	}
}

func TestCASCommitRejectsObjectLargerThanQuota(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 50)
	tmp, hash := writeCommitTemp(t, bytes.Repeat([]byte("x"), 60))

	_, err := store.commit(tmp, hash)

	if !errors.Is(err, errCASQuotaExceeded) {
		t.Fatalf("expected quota exceeded error, got %v", err)
	}
	if _, statErr := os.Stat(tmp); !os.IsNotExist(statErr) {
		t.Fatalf("expected rejected temp file to be removed, stat err=%v", statErr)
	}
	if got := countObjects(t, store); got != 0 {
		t.Fatalf("expected empty store, got %d objects", got)
	}
}

func TestCASCommitUnlimitedWhenQuotaZero(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 0)
	for i := 0; i < 8; i++ {
		mustCommitObject(t, store, bytes.Repeat([]byte{byte('a' + i)}, 400))
	}
	if got := countObjects(t, store); got != 8 {
		t.Fatalf("expected all 8 objects with unlimited quota, got %d", got)
	}
}

func TestCASCommitKeepsDedupWithoutQuotaHeadroom(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 50)
	data := bytes.Repeat([]byte("d"), 40)
	hash, _ := mustCommitObject(t, store, data)
	tmp, dupHash := writeCommitTemp(t, data)
	if dupHash != hash {
		t.Fatalf("hash mismatch for identical content")
	}
	path, err := store.commit(tmp, hash)
	if err != nil {
		t.Fatalf("dedup commit should succeed regardless of quota accounting: %v", err)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("dedup object missing: %v", statErr)
	}
	if got := countObjects(t, store); got != 1 {
		t.Fatalf("expected 1 object after dedup, got %d", got)
	}
}

func TestCASDownloadRefreshesRecencyForEviction(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 100)
	hashA, pathA := mustCommitObject(t, store, bytes.Repeat([]byte("a"), 40))
	_, pathB := mustCommitObject(t, store, bytes.Repeat([]byte("b"), 40))
	past := time.Now().Add(-2 * time.Hour)
	mustChtimes(t, pathA, past)
	mustChtimes(t, pathB, past.Add(time.Hour))

	response := httptest.NewRecorder()
	store.handleDownload(response, httptest.NewRequest(http.MethodGet, "/api/v1/files/sha256:"+hashA+"/content", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("download: status=%d body=%s", response.Code, response.Body.String())
	}

	hashC, _ := mustCommitObject(t, store, bytes.Repeat([]byte("c"), 40))

	if _, err := os.Stat(pathB); !os.IsNotExist(err) {
		t.Fatalf("expected stale object B to be evicted after A was re-read, stat err=%v", err)
	}
	if _, err := os.Stat(pathA); err != nil {
		t.Fatalf("expected recently read object A to survive, stat err=%v", err)
	}
	if _, err := os.Stat(store.objectPath(hashC)); err != nil {
		t.Fatalf("expected committed object to exist, stat err=%v", err)
	}
}

func TestCASQuotaFromEnvironment(t *testing.T) {
	t.Setenv("LINKOS_CAS_MAX_DISK_BYTES", "120")
	store := newUploadStore(t.TempDir())
	if store.content.maxDiskBytes != 120 {
		t.Fatalf("expected quota 120 from env, got %d", store.content.maxDiskBytes)
	}

	t.Setenv("LINKOS_CAS_MAX_DISK_BYTES", "not-a-number")
	invalid := newUploadStore(t.TempDir())
	if invalid.content.maxDiskBytes != 0 {
		t.Fatalf("expected fallback to unlimited for invalid env, got %d", invalid.content.maxDiskBytes)
	}
}

func TestUploadCompleteReturnsInsufficientStorageWhenQuotaExceeded(t *testing.T) {
	store := newUploadStore(t.TempDir())
	store.content.maxDiskBytes = 8
	session := createTestUpload(t, store, "big.bin", 16, 16)
	uploadPart(t, store, session.ID, 0, bytes.Repeat([]byte("z"), 16))

	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete", strings.NewReader(`{"contentHash":"`+sha256HexOf(bytes.Repeat([]byte("z"), 16))+`"}`))
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusInsufficientStorage {
		t.Fatalf("expected 507, got %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if payload.Error != "INSUFFICIENT_STORAGE" {
		t.Fatalf("expected INSUFFICIENT_STORAGE code, got %q", payload.Error)
	}

	view := getUpload(t, store, session.ID)
	if view.Status != "failed" {
		t.Fatalf("expected session to be marked failed, got %q", view.Status)
	}
}

func sha256HexOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
