package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

func TestCASCommitPreservesExistingBytesWhenQuotaExceeded(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 100)
	dataA := bytes.Repeat([]byte("a"), 40)
	dataB := bytes.Repeat([]byte("b"), 40)
	_, pathA := mustCommitObject(t, store, dataA)
	_, pathB := mustCommitObject(t, store, dataB)
	past := time.Now().Add(-2 * time.Hour)
	mustChtimes(t, pathA, past)
	mustChtimes(t, pathB, past.Add(time.Hour))

	tmp, hashC := writeCommitTemp(t, bytes.Repeat([]byte("c"), 40))
	path, err := store.commit(tmp, hashC)
	if !errors.Is(err, errCASQuotaExceeded) || path != "" {
		t.Errorf("expected quota rejection with no committed path, got path=%q err=%v", path, err)
	}
	for path, want := range map[string][]byte{pathA: dataA, pathB: dataB} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("existing bytes must survive quota failure: path=%s bytes=%q err=%v", path, got, err)
		}
	}
	if _, err := os.Stat(store.objectPath(hashC)); !os.IsNotExist(err) {
		t.Errorf("rejected object must not be committed, stat err=%v", err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("expected rejected temp file to be removed, stat err=%v", err)
	}
	if got := countObjects(t, store); got != 2 {
		t.Errorf("expected 2 unchanged objects after rejection, got %d", got)
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
	for _, quota := range []int64{40, 30} {
		t.Run(fmt.Sprintf("quota_%d", quota), func(t *testing.T) {
			store := newContentStoreWithQuota(t.TempDir(), 40)
			data := bytes.Repeat([]byte("d"), 40)
			hash, originalPath := mustCommitObject(t, store, data)
			// Dedup must also work if a configured quota is lowered below usage.
			store = newContentStoreWithQuota(store.root, quota)
			tmp, dupHash := writeCommitTemp(t, data)
			if dupHash != hash {
				t.Fatalf("hash mismatch for identical content")
			}
			path, err := store.commit(tmp, hash)
			if err != nil || path != originalPath {
				t.Fatalf("dedup commit should reuse existing object: path=%q err=%v", path, err)
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, data) {
				t.Fatalf("dedup object missing or changed: bytes=%q err=%v", got, err)
			}
			if _, err := os.Stat(tmp); !os.IsNotExist(err) {
				t.Fatalf("duplicate temp file must be removed, stat err=%v", err)
			}
			if got := countObjects(t, store); got != 1 {
				t.Fatalf("expected 1 object after dedup, got %d", got)
			}
		})
	}
}

func TestCASCommitAllowsTotalExactlyAtQuota(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 100)
	_, pathA := mustCommitObject(t, store, bytes.Repeat([]byte("a"), 40))
	mustCommitObject(t, store, bytes.Repeat([]byte("b"), 60))
	if got, err := os.ReadFile(pathA); err != nil || !bytes.Equal(got, bytes.Repeat([]byte("a"), 40)) {
		t.Fatalf("existing object changed at quota boundary: bytes=%q err=%v", got, err)
	}
	if got := countObjects(t, store); got != 2 {
		t.Fatalf("expected both objects at exact quota, got %d", got)
	}
}

func TestCASDownloadDoesNotAllowEvictionOnQuotaFailure(t *testing.T) {
	store := newContentStoreWithQuota(t.TempDir(), 100)
	dataA := bytes.Repeat([]byte("a"), 40)
	dataB := bytes.Repeat([]byte("b"), 40)
	hashA, pathA := mustCommitObject(t, store, dataA)
	hashB, pathB := mustCommitObject(t, store, dataB)
	past := time.Now().Add(-2 * time.Hour)
	mustChtimes(t, pathA, past)
	mustChtimes(t, pathB, past.Add(time.Hour))

	response := httptest.NewRecorder()
	store.handleDownload(response, httptest.NewRequest(http.MethodGet, "/api/v1/files/sha256:"+hashA+"/content", nil))
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), dataA) {
		t.Fatalf("download: status=%d body=%s", response.Code, response.Body.String())
	}

	tmp, hashC := writeCommitTemp(t, bytes.Repeat([]byte("c"), 40))
	if _, err := store.commit(tmp, hashC); !errors.Is(err, errCASQuotaExceeded) {
		t.Errorf("expected quota rejection after download, got %v", err)
	}
	for hash, want := range map[string][]byte{hashA: dataA, hashB: dataB} {
		response := httptest.NewRecorder()
		store.handleDownload(response, httptest.NewRequest(http.MethodGet, "/api/v1/files/sha256:"+hash+"/content", nil))
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), want) {
			t.Errorf("all existing objects must remain downloadable: hash=%s status=%d body=%q", hash, response.Code, response.Body.String())
		}
	}
	if _, err := os.Stat(store.objectPath(hashC)); !os.IsNotExist(err) {
		t.Errorf("rejected object must not be committed, stat err=%v", err)
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
	for _, size := range []int64{5, 16} {
		t.Run(fmt.Sprintf("incoming_%d", size), func(t *testing.T) {
			store := newUploadStore(t.TempDir())
			store.content.maxDiskBytes = 8
			existing := []byte("keep")
			hash, path := mustCommitObject(t, store.content, existing)
			data := bytes.Repeat([]byte("z"), int(size))
			session := createTestUpload(t, store, "big.bin", size, size)
			uploadPart(t, store, session.ID, 0, data)

			request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete", strings.NewReader(`{"contentHash":"`+sha256HexOf(data)+`"}`))
			response := httptest.NewRecorder()
			store.handleItem(response, request)
			if response.Code != http.StatusInsufficientStorage {
				t.Errorf("expected 507, got %d body=%s", response.Code, response.Body.String())
			}
			var payload struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error body: %v", err)
			}
			if payload.Error != "INSUFFICIENT_STORAGE" {
				t.Errorf("expected INSUFFICIENT_STORAGE code, got %q", payload.Error)
			}

			view := getUpload(t, store, session.ID)
			if view.Status != "failed" {
				t.Errorf("expected session to be marked failed, got %q", view.Status)
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, existing) {
				t.Errorf("existing bytes must survive failed upload: bytes=%q err=%v", got, err)
			}
			download := httptest.NewRecorder()
			store.content.handleDownload(download, httptest.NewRequest(http.MethodGet, "/api/v1/files/sha256:"+hash+"/content", nil))
			if download.Code != http.StatusOK || !bytes.Equal(download.Body.Bytes(), existing) {
				t.Errorf("existing file must remain downloadable: status=%d body=%q", download.Code, download.Body.String())
			}
			if _, err := os.Stat(store.content.objectPath(sha256HexOf(data))); !os.IsNotExist(err) {
				t.Errorf("failed upload must not commit content, stat err=%v", err)
			}
		})
	}
}

func sha256HexOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
