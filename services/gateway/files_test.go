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
	"testing"
)

func TestUploadCompletesIntoContentAddressedStore(t *testing.T) {
	root := t.TempDir()
	store := newUploadStore(root)
	content := []byte("0123456789abcdef")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])
	resourceID := "sha256:" + hash

	session := createTestUpload(t, store, "artifact.bin", int64(len(content)), 5)
	for partNo := 0; partNo < session.TotalParts; partNo++ {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	completeUpload(t, store, session.ID, hash)

	final := getUpload(t, store, session.ID)
	if final.Status != "completed" || final.ResourceID != resourceID {
		t.Fatalf("completed state = %#v, want resourceId %s", final, resourceID)
	}
	stored, err := os.ReadFile(store.content.objectPath(hash))
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatalf("content-addressed object missing or wrong: %v", err)
	}

	// Re-uploading identical content must reuse the same object.
	second := createTestUpload(t, store, "copy.bin", int64(len(content)), 5)
	for partNo := 0; partNo < second.TotalParts; partNo++ {
		uploadPart(t, store, second.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	completeUpload(t, store, second.ID, hash)
	if state := getUpload(t, store, second.ID); state.ResourceID != resourceID {
		t.Fatalf("second resourceId = %s, want %s", state.ResourceID, resourceID)
	}
	objects := 0
	_ = filepath.WalkDir(filepath.Join(root, "objects"), func(_ string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			objects++
		}
		return nil
	})
	if objects != 1 {
		t.Fatalf("expected 1 deduplicated object, found %d", objects)
	}
}

func TestFileDownloadServesFullAndPartialContent(t *testing.T) {
	store := newUploadStore(t.TempDir())
	content := []byte("0123456789abcdef")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createTestUpload(t, store, "artifact.bin", int64(len(content)), 5)
	for partNo := 0; partNo < session.TotalParts; partNo++ {
		uploadPart(t, store, session.ID, partNo, content[partNo*5:min((partNo+1)*5, len(content))])
	}
	completeUpload(t, store, session.ID, hash)
	url := "/api/v1/files/sha256:" + hash + "/content"

	fullResponse := httptest.NewRecorder()
	store.content.handleDownload(fullResponse, httptest.NewRequest(http.MethodGet, url, nil))
	if fullResponse.Code != http.StatusOK || !bytes.Equal(fullResponse.Body.Bytes(), content) {
		t.Fatalf("full download: status=%d body=%q", fullResponse.Code, fullResponse.Body.String())
	}
	if fullResponse.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("full download missing Accept-Ranges: %#v", fullResponse.Header())
	}

	rangeRequest := httptest.NewRequest(http.MethodGet, url, nil)
	rangeRequest.Header.Set("Range", "bytes=5-9")
	rangeResponse := httptest.NewRecorder()
	store.content.handleDownload(rangeResponse, rangeRequest)
	if rangeResponse.Code != http.StatusPartialContent || rangeResponse.Body.String() != "56789" {
		t.Fatalf("range download: status=%d body=%q", rangeResponse.Code, rangeResponse.Body.String())
	}
	if got := rangeResponse.Header().Get("Content-Range"); got != "bytes 5-9/16" {
		t.Fatalf("range download Content-Range = %q", got)
	}

	tailRequest := httptest.NewRequest(http.MethodGet, url, nil)
	tailRequest.Header.Set("Range", "bytes=15-")
	tailResponse := httptest.NewRecorder()
	store.content.handleDownload(tailResponse, tailRequest)
	if tailResponse.Code != http.StatusPartialContent || tailResponse.Body.String() != "f" {
		t.Fatalf("tail download: status=%d body=%q", tailResponse.Code, tailResponse.Body.String())
	}

	invalidRequest := httptest.NewRequest(http.MethodGet, url, nil)
	invalidRequest.Header.Set("Range", "bytes=99-120")
	invalidResponse := httptest.NewRecorder()
	store.content.handleDownload(invalidResponse, invalidRequest)
	if invalidResponse.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("out-of-range download: status=%d", invalidResponse.Code)
	}

	missing := httptest.NewRecorder()
	store.content.handleDownload(missing, httptest.NewRequest(http.MethodGet, "/api/v1/files/sha256:"+stringsRepeat("0", 64)+"/content", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("unknown resource: status=%d", missing.Code)
	}

	malformed := httptest.NewRecorder()
	store.content.handleDownload(malformed, httptest.NewRequest(http.MethodGet, "/api/v1/files/not-a-resource/content", nil))
	if malformed.Code != http.StatusNotFound {
		t.Fatalf("malformed resource: status=%d", malformed.Code)
	}

	wrongMethod := httptest.NewRecorder()
	store.content.handleDownload(wrongMethod, httptest.NewRequest(http.MethodPost, url, nil))
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method: status=%d", wrongMethod.Code)
	}
}

func createTestUpload(t *testing.T, store *uploadStore, name string, size, chunkSize int64) uploadViewModel {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"size":%d,"mimeType":"application/octet-stream","chunkSize":%d}`, name, size, chunkSize)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(body))
	response := httptest.NewRecorder()
	store.handleCollection(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", response.Code, response.Body.String())
	}
	var session uploadViewModel
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	return session
}

func completeUpload(t *testing.T, store *uploadStore, id, hash string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+id+"/complete", bytes.NewBufferString(`{"contentHash":"`+hash+`"}`))
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("complete upload: status=%d body=%s", response.Code, response.Body.String())
	}
}
