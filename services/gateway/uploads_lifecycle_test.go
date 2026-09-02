package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadCompleteRemovesSessionDirectory(t *testing.T) {
	store := newUploadStore(t.TempDir())
	content := []byte("0123456789abcdef")
	session := createTestUpload(t, store, "artifact.bin", int64(len(content)), 5)
	for partNo := 0; partNo < session.TotalParts; partNo++ {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	fullHash := sha256.Sum256(content)
	completeUpload(t, store, session.ID, hex.EncodeToString(fullHash[:]))

	directory := filepath.Join(store.root, session.ID)
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("completed upload directory must be removed once committed, stat err=%v", err)
	}
	if _, err := os.Stat(store.content.objectPath(hex.EncodeToString(fullHash[:]))); err != nil {
		t.Fatalf("content-addressed object must survive session cleanup: %v", err)
	}
	final := getUpload(t, store, session.ID)
	if final.Status != "completed" {
		t.Fatalf("completed upload must stay queryable after cleanup, got %s", final.Status)
	}
}

func TestFailedUploadRemovesSessionDirectory(t *testing.T) {
	store := newUploadStore(t.TempDir())
	store.maxActiveUploads = 1
	content := []byte("0123456789abcdef")
	session := createTestUpload(t, store, "artifact.bin", int64(len(content)), 5)
	for partNo := 0; partNo < session.TotalParts; partNo++ {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete",
		bytes.NewBufferString(`{"contentHash":"`+strings.Repeat("0", 64)+`"}`))
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected hash mismatch failure, got %d body=%s", response.Code, response.Body.String())
	}

	directory := filepath.Join(store.root, session.ID)
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("failed upload directory must be removed, stat err=%v", err)
	}
	state := getUpload(t, store, session.ID)
	if state.Status != "failed" {
		t.Fatalf("session must stay failed and queryable, got %s", state.Status)
	}
	// Failed sessions must not keep occupying an active slot.
	next := createTestUpload(t, store, "next.bin", 4, 4)
	if next.Status != "created" {
		t.Fatalf("failed upload must free its active slot, got %s", next.Status)
	}
}

func TestUploadCreateRejectsOversizedFile(t *testing.T) {
	store := newUploadStore(t.TempDir())
	store.maxFileSize = 100
	response := httptest.NewRecorder()
	store.handleCollection(response, httptest.NewRequest(http.MethodPost, "/api/v1/uploads",
		bytes.NewBufferString(`{"name":"big.bin","size":101}`)))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized create must be rejected, got %d body=%s", response.Code, response.Body.String())
	}
	var apiError struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &apiError); err != nil {
		t.Fatalf("decode error payload: %v", err)
	}
	if apiError.Error != "UPLOAD_TOO_LARGE" {
		t.Fatalf("oversized create error code = %q, want UPLOAD_TOO_LARGE", apiError.Error)
	}
	if len(store.sessions) != 0 {
		t.Fatalf("rejected create must not leave a session, got %d", len(store.sessions))
	}
	accepted := createTestUpload(t, store, "ok.bin", 100, 50)
	if accepted.Status != "created" {
		t.Fatalf("upload at the size limit must be accepted, got %s", accepted.Status)
	}
}

func TestUploadCreateAssignsDistinctSessionIDs(t *testing.T) {
	store := newUploadStore(t.TempDir())
	ids := make(map[string]bool)
	for i := 0; i < 16; i++ {
		session := createTestUpload(t, store, fmt.Sprintf("file-%d.bin", i), 4, 4)
		if ids[session.ID] {
			t.Fatalf("duplicate upload id %s on create %d", session.ID, i)
		}
		ids[session.ID] = true
	}
	if len(store.sessions) != 16 {
		t.Fatalf("rapid creates must yield 16 distinct sessions, got %d", len(store.sessions))
	}
}

func TestUploadCreateRejectsWhenActiveLimitReached(t *testing.T) {
	store := newUploadStore(t.TempDir())
	store.maxActiveUploads = 2
	first := createTestUpload(t, store, "a.bin", 8, 4)
	second := createTestUpload(t, store, "b.bin", 8, 4)

	response := httptest.NewRecorder()
	store.handleCollection(response, httptest.NewRequest(http.MethodPost, "/api/v1/uploads",
		bytes.NewBufferString(`{"name":"c.bin","size":8}`)))
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("create beyond the active limit must return 429, got %d body=%s", response.Code, response.Body.String())
	}
	var apiError struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &apiError); err != nil {
		t.Fatalf("decode error payload: %v", err)
	}
	if apiError.Error != "TOO_MANY_ACTIVE_UPLOADS" {
		t.Fatalf("active-limit error code = %q, want TOO_MANY_ACTIVE_UPLOADS", apiError.Error)
	}
	if len(store.sessions) != 2 {
		t.Fatalf("rejected create must not leave a session, got %d", len(store.sessions))
	}

	content := []byte("abcdefgh")
	for partNo := 0; partNo < first.TotalParts; partNo++ {
		uploadPart(t, store, first.ID, partNo, content[partNo*4:(partNo+1)*4])
	}
	fullHash := sha256.Sum256(content)
	completeUpload(t, store, first.ID, hex.EncodeToString(fullHash[:]))

	third := createTestUpload(t, store, "d.bin", 8, 4)
	if third.Status != "created" {
		t.Fatalf("completing an upload must free an active slot, got %s", third.Status)
	}
	_ = second
}

func TestUploadLimitsFromEnvironment(t *testing.T) {
	t.Setenv("LINKOS_UPLOAD_MAX_FILE_SIZE", "2048")
	t.Setenv("LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS", "3")
	configured := newUploadStoreWithBackend(t.TempDir(), memoryBackend{})
	if configured.maxFileSize != 2048 {
		t.Fatalf("LINKOS_UPLOAD_MAX_FILE_SIZE not applied: %d", configured.maxFileSize)
	}
	if configured.maxActiveUploads != 3 {
		t.Fatalf("LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS not applied: %d", configured.maxActiveUploads)
	}

	t.Setenv("LINKOS_UPLOAD_MAX_FILE_SIZE", "not-a-number")
	t.Setenv("LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS", "-2")
	fallback := newUploadStoreWithBackend(t.TempDir(), memoryBackend{})
	if fallback.maxFileSize != defaultMaxUploadFileSize {
		t.Fatalf("invalid size limit must fall back to default, got %d", fallback.maxFileSize)
	}
	if fallback.maxActiveUploads != defaultMaxActiveUploads {
		t.Fatalf("invalid active limit must fall back to default, got %d", fallback.maxActiveUploads)
	}
}
