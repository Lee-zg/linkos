package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func newDirectoryTestStores(t *testing.T) (*uploadStore, *mvpStore, *authStore) {
	t.Helper()
	root := t.TempDir()
	backend := newTestSQLiteBackend(t, "")
	h := newHub()
	mvp := newMVPStore(backend, h)
	policy := newAccessPolicy()
	policy.set(false, true)
	auth := newAuthStore("demo", "test-passcode", policy, newAccessStore())
	registerMVPAuth(mvp, auth)
	uploads := newUploadStoreWithBackend(root, backend)
	uploads.auth = auth
	uploads.committer = mvp
	mvp.content = uploads.content
	mvp.contentDownload = uploads.content.handleDownload
	return uploads, mvp, auth
}

func directoryToken(t *testing.T, auth *authStore) string {
	t.Helper()
	principal, _, code := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Tester", AccessType: accessTypeLogin, Passcode: "test-passcode",
	})
	if code != "" {
		t.Fatalf("issue session: %s", code)
	}
	return principal.Token
}

func createDirectoryUpload(t *testing.T, store *uploadStore, token, name string, size, chunkSize int64, parentID string) uploadViewModel {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"size":%d,"mimeType":"application/octet-stream","chunkSize":%d,"parentId":%q}`,
		name, size, chunkSize, parentID)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+token)
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

func completeDirectoryUpload(t *testing.T, store *uploadStore, token, id, hash string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/"+id+"/complete",
		bytes.NewBufferString(`{"contentHash":"`+hash+`"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	return response
}

func uploadDirectoryPart(t *testing.T, store *uploadStore, token, id string, partNo int, content []byte) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/uploads/%s/parts/%d", id, partNo), bytes.NewReader(content))
	request.Header.Set("Authorization", "Bearer "+token)
	hash := sha256.Sum256(content)
	request.Header.Set("X-Part-SHA256", hex.EncodeToString(hash[:]))
	response := httptest.NewRecorder()
	store.handleItem(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("upload part: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestUploadCompleteCreatesDirectoryEntry(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("hello directory world")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "test.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)

	response := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	if response.Code != http.StatusCreated {
		t.Fatalf("complete: status=%d body=%s", response.Code, response.Body.String())
	}

	var result struct {
		EntryID   string `json:"entryId"`
		FinalName string `json:"finalName"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.EntryID == "" {
		t.Fatal("expected entryId in response")
	}
	if result.FinalName != "test.txt" {
		t.Fatalf("finalName = %q, want test.txt", result.FinalName)
	}

	mvp.mu.RLock()
	entry, exists := mvp.state.Resources[result.EntryID]
	mvp.mu.RUnlock()
	if !exists {
		t.Fatal("directory entry not created in mvp store")
	}
	if entry.Type != "file" {
		t.Fatalf("entry type = %q, want file", entry.Type)
	}
	if entry.Name != "test.txt" {
		t.Fatalf("entry name = %q, want test.txt", entry.Name)
	}
	if entry.ParentID != "" {
		t.Fatalf("entry parentId = %q, want root", entry.ParentID)
	}
	contentHash, _ := entry.Meta["contentHash"].(string)
	if contentHash != hash {
		t.Fatalf("entry contentHash = %q, want %s", contentHash, hash)
	}
}

func TestUploadCompleteAutoNumbersOnNameConflict(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("first file content")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	first := createDirectoryUpload(t, uploads, token, "report.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, first.ID, 0, content)
	completeDirectoryUpload(t, uploads, token, first.ID, hash)

	content2 := []byte("second file content!")
	fullHash2 := sha256.Sum256(content2)
	hash2 := hex.EncodeToString(fullHash2[:])

	second := createDirectoryUpload(t, uploads, token, "report.txt", int64(len(content2)), int64(len(content2)), "")
	uploadDirectoryPart(t, uploads, token, second.ID, 0, content2)
	response := completeDirectoryUpload(t, uploads, token, second.ID, hash2)

	var result struct {
		FinalName string `json:"finalName"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.FinalName != "report (2).txt" {
		t.Fatalf("auto-numbered name = %q, want 'report (2).txt'", result.FinalName)
	}

	mvp.mu.RLock()
	count := 0
	for _, item := range mvp.state.Resources {
		if item.Type == "file" {
			count++
		}
	}
	mvp.mu.RUnlock()
	if count != 2 {
		t.Fatalf("expected 2 file entries, got %d", count)
	}
}

func TestUploadCompleteIdempotentNoDuplicateEntry(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("idempotent content")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "once.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)

	first := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	if first.Code != http.StatusCreated {
		t.Fatalf("first complete: status=%d body=%s", first.Code, first.Body.String())
	}
	var firstResult struct{ EntryID string }
	_ = json.Unmarshal(first.Body.Bytes(), &firstResult)

	second := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	if second.Code != http.StatusOK && second.Code != http.StatusCreated {
		t.Fatalf("second complete: status=%d body=%s", second.Code, second.Body.String())
	}
	var secondResult struct{ EntryID string }
	_ = json.Unmarshal(second.Body.Bytes(), &secondResult)

	if firstResult.EntryID != secondResult.EntryID {
		t.Fatalf("idempotent complete returned different entryId: %q vs %q", firstResult.EntryID, secondResult.EntryID)
	}

	mvp.mu.RLock()
	count := 0
	for _, item := range mvp.state.Resources {
		if item.Type == "file" && item.Name == "once.txt" {
			count++
		}
	}
	mvp.mu.RUnlock()
	if count != 1 {
		t.Fatalf("expected exactly 1 entry, got %d", count)
	}
}

func TestUploadCompleteFailsWhenParentDeleted(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	folderResp := httptest.NewRecorder()
	folderBody := `{"type":"folder","name":"temp"}`
	folderReq := httptest.NewRequest(http.MethodPost, "/api/v1/resources", bytes.NewBufferString(folderBody))
	folderReq.Header.Set("Authorization", "Bearer "+token)
	mvp.handleFilesResources(folderResp, folderReq)
	if folderResp.Code != http.StatusCreated {
		t.Fatalf("create folder: status=%d body=%s", folderResp.Code, folderResp.Body.String())
	}
	var folder struct{ ID string }
	_ = json.Unmarshal(folderResp.Body.Bytes(), &folder)

	content := []byte("orphan content!!")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "orphan.txt", int64(len(content)), int64(len(content)), folder.ID)
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)

	mvp.mu.Lock()
	delete(mvp.state.Resources, folder.ID)
	mvp.bumpResourceRevision()
	mvp.persistLocked()
	mvp.mu.Unlock()

	response := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	if response.Code == http.StatusCreated {
		t.Fatal("complete should fail when parent is deleted")
	}
	if response.Code != http.StatusConflict && response.Code != http.StatusNotFound {
		t.Fatalf("expected 409 or 404, got %d body=%s", response.Code, response.Body.String())
	}
}

func TestUploadEntryIDAssignedAtCreation(t *testing.T) {
	uploads, _, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	session := createDirectoryUpload(t, uploads, token, "preview.txt", 4, 4, "")
	if session.EntryID == "" {
		t.Fatal("expected entryId to be assigned at upload creation")
	}
	if session.ParentID != "" {
		t.Fatalf("expected empty parentId, got %q", session.ParentID)
	}
}

func TestUploadLegacyCASDoesNotAssignEntryID(t *testing.T) {
	uploads := newUploadStore(t.TempDir())

	body := `{"name":"no-parent.txt","size":4,"chunkSize":4}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(body))
	response := httptest.NewRecorder()
	uploads.handleCollection(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", response.Code, response.Body.String())
	}
	var session uploadViewModel
	_ = json.Unmarshal(response.Body.Bytes(), &session)
	if session.EntryID != "" {
		t.Fatalf("legacy auth-nil CAS upload should not assign entryId, got %q", session.EntryID)
	}
}

func TestAuthorizedDownloadByEntryID(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("download me by entry")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "download.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)
	completeResp := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	var result struct{ EntryID string }
	_ = json.Unmarshal(completeResp.Body.Bytes(), &result)

	downloadURL := "/api/v1/files/" + result.EntryID + "/content"
	downloadReq := httptest.NewRequest(http.MethodGet, downloadURL, nil)
	downloadReq.Header.Set("Authorization", "Bearer "+token)
	downloadResp := httptest.NewRecorder()
	mvp.handleAuthorizedDownload(downloadResp, downloadReq)

	if downloadResp.Code != http.StatusOK {
		t.Fatalf("download: status=%d body=%s", downloadResp.Code, downloadResp.Body.String())
	}
	if !bytes.Equal(downloadResp.Body.Bytes(), content) {
		t.Fatalf("download content mismatch: %q", downloadResp.Body.String())
	}
}

func TestAuthorizedDownloadChecksAncestorPermission(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("restricted content")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	folderResp := httptest.NewRecorder()
	folderBody := `{"type":"folder","name":"private"}`
	folderReq := httptest.NewRequest(http.MethodPost, "/api/v1/resources", bytes.NewBufferString(folderBody))
	folderReq.Header.Set("Authorization", "Bearer "+token)
	mvp.handleFilesResources(folderResp, folderReq)
	var folder struct{ ID string }
	_ = json.Unmarshal(folderResp.Body.Bytes(), &folder)

	session := createDirectoryUpload(t, uploads, token, "secret.txt", int64(len(content)), int64(len(content)), folder.ID)
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)
	completeResp := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	var result struct{ EntryID string }
	_ = json.Unmarshal(completeResp.Body.Bytes(), &result)

	mvp.mu.Lock()
	folderItem := mvp.state.Resources[folder.ID]
	folderItem.ACL = protocol.ResourceACL{}
	mvp.state.Resources[folder.ID] = folderItem
	mvp.mu.Unlock()

	guestPrincipal, _, _ := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Guest", AccessType: accessTypeGuest,
	})

	downloadURL := "/api/v1/files/" + result.EntryID + "/content"
	downloadReq := httptest.NewRequest(http.MethodGet, downloadURL, nil)
	downloadReq.Header.Set("Authorization", "Bearer "+guestPrincipal.Token)
	downloadResp := httptest.NewRecorder()
	mvp.handleAuthorizedDownload(downloadResp, downloadReq)

	if downloadResp.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized ancestor, got %d body=%s", downloadResp.Code, downloadResp.Body.String())
	}
}

func TestLegacyCASDownloadStillWorks(t *testing.T) {
	uploads := newUploadStore(t.TempDir())

	content := []byte("legacy cas content")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createTestUpload(t, uploads, "legacy.bin", int64(len(content)), int64(len(content)))
	uploadPart(t, uploads, session.ID, 0, content)
	completeUpload(t, uploads, session.ID, hash)

	legacyURL := "/api/v1/files/sha256:" + hash + "/content"
	legacyReq := httptest.NewRequest(http.MethodGet, legacyURL, nil)
	legacyResp := httptest.NewRecorder()
	uploads.content.handleDownload(legacyResp, legacyReq)

	if legacyResp.Code != http.StatusOK {
		t.Fatalf("legacy download: status=%d body=%s", legacyResp.Code, legacyResp.Body.String())
	}
	if !bytes.Equal(legacyResp.Body.Bytes(), content) {
		t.Fatalf("legacy content mismatch: %q", legacyResp.Body.String())
	}
}

func TestDeleteDirectoryEntryDoesNotRemoveCASObject(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("shared content!!")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "shared.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)
	completeResp := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	var result struct{ EntryID string }
	_ = json.Unmarshal(completeResp.Body.Bytes(), &result)

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/resources/"+result.EntryID, nil)
	deleteReq.Header.Set("Authorization", "Bearer "+token)
	deleteResp := httptest.NewRecorder()
	mvp.handleFilesResourceItem(deleteResp, deleteReq)

	legacyURL := "/api/v1/files/sha256:" + hash + "/content"
	legacyReq := httptest.NewRequest(http.MethodGet, legacyURL, nil)
	legacyResp := httptest.NewRecorder()
	mvp.content.handleDownload(legacyResp, legacyReq)
	if legacyResp.Code != http.StatusOK {
		t.Fatalf("CAS object should survive directory entry deletion, got status=%d", legacyResp.Code)
	}
}

func TestUploadCompleteIntoSubfolder(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	folderResp := httptest.NewRecorder()
	folderBody := `{"type":"folder","name":"docs"}`
	folderReq := httptest.NewRequest(http.MethodPost, "/api/v1/resources", bytes.NewBufferString(folderBody))
	folderReq.Header.Set("Authorization", "Bearer "+token)
	mvp.handleFilesResources(folderResp, folderReq)
	if folderResp.Code != http.StatusCreated {
		t.Fatalf("create folder: status=%d", folderResp.Code)
	}
	var folder struct{ ID string }
	_ = json.Unmarshal(folderResp.Body.Bytes(), &folder)

	content := []byte("nested file content")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "nested.txt", int64(len(content)), int64(len(content)), folder.ID)
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)
	completeResp := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	if completeResp.Code != http.StatusCreated {
		t.Fatalf("complete: status=%d body=%s", completeResp.Code, completeResp.Body.String())
	}

	var result struct{ EntryID string }
	_ = json.Unmarshal(completeResp.Body.Bytes(), &result)

	mvp.mu.RLock()
	entry := mvp.state.Resources[result.EntryID]
	mvp.mu.RUnlock()
	if entry.ParentID != folder.ID {
		t.Fatalf("entry parentId = %q, want %q", entry.ParentID, folder.ID)
	}
}

func TestFilePatchCannotOverwriteContentMeta(t *testing.T) {
	uploads, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)

	content := []byte("protected meta!!!!")
	fullHash := sha256.Sum256(content)
	hash := hex.EncodeToString(fullHash[:])

	session := createDirectoryUpload(t, uploads, token, "protected.txt", int64(len(content)), int64(len(content)), "")
	uploadDirectoryPart(t, uploads, token, session.ID, 0, content)
	completeResp := completeDirectoryUpload(t, uploads, token, session.ID, hash)
	var result struct{ EntryID string }
	_ = json.Unmarshal(completeResp.Body.Bytes(), &result)

	patchBody := `{"meta":{"contentHash":"fake","size":999}}`
	patchReq := httptest.NewRequest(http.MethodPatch, "/api/v1/resources/"+result.EntryID, bytes.NewBufferString(patchBody))
	patchReq.Header.Set("Authorization", "Bearer "+token)
	patchResp := httptest.NewRecorder()
	mvp.handleFilesResourceItem(patchResp, patchReq)

	if patchResp.Code == http.StatusOK {
		mvp.mu.RLock()
		entry := mvp.state.Resources[result.EntryID]
		mvp.mu.RUnlock()
		originalHash, _ := entry.Meta["contentHash"].(string)
		if originalHash != hash {
			t.Fatalf("contentHash was overwritten: got %q, want %q", originalHash, hash)
		}
	}
}
