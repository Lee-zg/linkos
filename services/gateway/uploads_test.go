package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestUploadRoundTripSupportsResumeAndHashVerification(t *testing.T) {
	store := newUploadStore(t.TempDir())
	content := []byte("0123456789abcdef")
	fullHash := sha256.Sum256(content)

	createBody := bytes.NewBufferString(`{"name":"artifact.bin","size":16,"mimeType":"application/octet-stream","chunkSize":5}`)
	createRequest := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", createBody)
	createResponse := httptest.NewRecorder()
	store.handleCollection(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var session uploadViewModel
	if err := json.Unmarshal(createResponse.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.TotalParts != 4 || session.ChunkSize != 5 || session.Status != "created" {
		t.Fatalf("unexpected session: %#v", session)
	}

	// Upload out of order to exercise the resume state returned by GET.
	for _, partNo := range []int{0, 2} {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	// Retrying an already acknowledged part must be idempotent.
	uploadPart(t, store, session.ID, 0, content[:5])
	state := getUpload(t, store, session.ID)
	if !reflect.DeepEqual(state.ReceivedParts, []int{0, 2}) {
		t.Fatalf("unexpected resumed parts: %#v", state.ReceivedParts)
	}
	for _, partNo := range []int{1, 3} {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}

	completeBody := bytes.NewBufferString(`{"contentHash":"` + hex.EncodeToString(fullHash[:]) + `"}`)
	completeRequest := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete", completeBody)
	completeResponse := httptest.NewRecorder()
	store.handleItem(completeResponse, completeRequest)
	if completeResponse.Code != http.StatusCreated {
		t.Fatalf("complete upload: status=%d body=%s", completeResponse.Code, completeResponse.Body.String())
	}
	finalState := getUpload(t, store, session.ID)
	if finalState.Status != "completed" || finalState.ResourceID != "sha256:"+hex.EncodeToString(fullHash[:]) {
		t.Fatalf("unexpected completed state: %#v", finalState)
	}
	completed, err := os.ReadFile(store.content.objectPath(hex.EncodeToString(fullHash[:])))
	if err != nil {
		t.Fatalf("read content-addressed object: %v", err)
	}
	if !bytes.Equal(completed, content) {
		t.Fatalf("completed content mismatch: %q", completed)
	}
}

func TestUploadRejectsInvalidPartAndMissingParts(t *testing.T) {
	store := newUploadStore(t.TempDir())
	createRequest := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(`{"name":"artifact.bin","size":4,"chunkSize":2}`))
	createResponse := httptest.NewRecorder()
	store.handleCollection(createResponse, createRequest)
	var session uploadViewModel
	if err := json.Unmarshal(createResponse.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	badRequest := httptest.NewRequest(http.MethodPatch, "/api/v1/uploads/"+session.ID+"/parts/0", bytes.NewReader([]byte("no")))
	badRequest.Header.Set("X-Part-SHA256", stringsRepeat("0", 64))
	badResponse := httptest.NewRecorder()
	store.handleItem(badResponse, badRequest)
	if badResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected invalid hash status, got %d body=%s", badResponse.Code, badResponse.Body.String())
	}

	completeRequest := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete", bytes.NewBufferString(`{"contentHash":"`+stringsRepeat("0", 64)+`"}`))
	completeResponse := httptest.NewRecorder()
	store.handleItem(completeResponse, completeRequest)
	if completeResponse.Code != http.StatusConflict {
		t.Fatalf("expected missing part conflict, got %d body=%s", completeResponse.Code, completeResponse.Body.String())
	}
}

func uploadPart(t *testing.T, store *uploadStore, id string, partNo int, content []byte) {
	t.Helper()
	hash := sha256.Sum256(content)
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/uploads/"+id+"/parts/"+itoa(partNo), bytes.NewReader(content))
	request.Header.Set("X-Part-SHA256", hex.EncodeToString(hash[:]))
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("upload part %d: status=%d body=%s", partNo, response.Code, response.Body.String())
	}
}

func getUpload(t *testing.T, store *uploadStore, id string) uploadViewModel {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/uploads/"+id, nil)
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("get upload: status=%d body=%s", response.Code, response.Body.String())
	}
	var session uploadViewModel
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode upload state: %v", err)
	}
	return session
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

func stringsRepeat(value string, count int) string {
	return string(bytes.Repeat([]byte(value), count))
}

func TestUploadResumeAcrossRestart(t *testing.T) {
	root := t.TempDir()
	path := testSQLitePath(t)
	backend, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("open backend: %v", err)
	}
	store := newUploadStoreWithBackend(root, backend)
	content := []byte("0123456789abcdef")
	fullHash := sha256.Sum256(content)

	createResponse := httptest.NewRecorder()
	store.handleCollection(createResponse, httptest.NewRequest(http.MethodPost, "/api/v1/uploads",
		bytes.NewBufferString(`{"name":"artifact.bin","size":16,"chunkSize":5}`)))
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var session uploadViewModel
	if err := json.Unmarshal(createResponse.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	uploadPart(t, store, session.ID, 0, content[:5])
	if err := backend.Close(); err != nil {
		t.Fatalf("close backend: %v", err)
	}

	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen backend: %v", err)
	}
	defer reopened.Close()
	restored := newUploadStoreWithBackend(root, reopened)

	state := getUpload(t, restored, session.ID)
	if state.Status != "uploading" || !reflect.DeepEqual(state.ReceivedParts, []int{0}) {
		t.Fatalf("upload session must resume after restart, got %#v", state)
	}
	for _, partNo := range []int{1, 2, 3} {
		uploadPart(t, restored, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	completeResponse := httptest.NewRecorder()
	restored.handleItem(completeResponse, httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+session.ID+"/complete",
		bytes.NewBufferString(`{"contentHash":"`+hex.EncodeToString(fullHash[:])+`"}`)))
	if completeResponse.Code != http.StatusCreated {
		t.Fatalf("complete resumed upload: status=%d body=%s", completeResponse.Code, completeResponse.Body.String())
	}
	completed, err := os.ReadFile(restored.content.objectPath(hex.EncodeToString(fullHash[:])))
	if err != nil {
		t.Fatalf("read content-addressed object: %v", err)
	}
	if !bytes.Equal(completed, content) {
		t.Fatalf("completed content mismatch: %q", completed)
	}
}

func TestUploadRestoreDowngradesVerifying(t *testing.T) {
	root := t.TempDir()
	backend := newTestSQLiteBackend(t, "")
	session := uploadSession{
		id:         "up_verifying",
		name:       "artifact.bin",
		size:       4,
		mimeType:   "application/octet-stream",
		chunkSize:  2,
		totalParts: 2,
		received:   map[int]int64{0: 2, 1: 2},
		status:     "verifying",
		directory:  filepath.Join(root, "up_verifying"),
	}
	if err := backend.saveUploadSession(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	store := newUploadStoreWithBackend(root, backend)
	state := getUpload(t, store, session.id)
	if state.Status != "uploading" {
		t.Fatalf("sessions interrupted mid-verification must resume as uploading, got %s", state.Status)
	}
}
