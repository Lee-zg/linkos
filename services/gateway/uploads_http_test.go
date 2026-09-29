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
	"sync"
	"testing"
	"time"
)

// Exercise the production routing and authentication middleware, not a synthetic
// owner in the request body or a direct call to the completion helper.
func uploadHTTPHandler(store *uploadStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/uploads", requireActive(store.auth, "demo", store.handleCollection))
	mux.HandleFunc("/api/v1/uploads/", requireActive(store.auth, "demo", store.handleItem))
	return mux
}

func uploadHTTPRequest(handler http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	hash := sha256.Sum256([]byte(body))
	r.Header.Set("X-Part-SHA256", hex.EncodeToString(hash[:]))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestUploadHTTPDerivesIdentityAndPersistsEntryID(t *testing.T) {
	for _, extra := range []string{"", `,"ownerId":"spoof","workspaceId":"other"`} {
		t.Run(extra, func(t *testing.T) {
			store, _, auth := newDirectoryTestStores(t)
			token := directoryToken(t, auth)
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			principal, _ := principalForRequest(auth, request)
			response := uploadHTTPRequest(uploadHTTPHandler(store), token, http.MethodPost, "/api/v1/uploads", `{"name":"owned.txt","size":4,"chunkSize":4`+extra+`}`)
			if response.Code != http.StatusCreated {
				t.Fatalf("create: %d %s", response.Code, response.Body.String())
			}
			var view uploadViewModel
			if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
				t.Fatal(err)
			}
			if view.OwnerID != principal.UserID || view.WorkspaceID != principal.WorkspaceID || view.EntryID == "" {
				t.Fatalf("identity must come from token and entryId must be allocated: %+v", view)
			}
			sessions, err := store.backend.loadUploadSessions()
			if err != nil || len(sessions) != 1 || sessions[0].entryID != view.EntryID {
				t.Fatalf("entryId must be durable before create succeeds: %+v %v", sessions, err)
			}
		})
	}
}

func TestUploadHTTPRejectsGuestAndForeignSessions(t *testing.T) {
	store, _, auth := newDirectoryTestStores(t)
	ownerToken := directoryToken(t, auth)
	otherToken := directoryToken(t, auth)
	guest, _, code := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "Guest", AccessType: accessTypeGuest})
	if code != "" {
		t.Fatal(code)
	}
	auth.mu.Lock()
	owner := auth.sessions[ownerToken]
	other := auth.sessions[otherToken]
	other.Role = roleMember
	auth.sessions[otherToken] = other
	auth.mu.Unlock()
	if other.UserID == owner.UserID {
		t.Fatal("test requires distinct owners")
	}
	store.sessions["up_owned"] = &uploadSession{id: "up_owned", ownerID: owner.UserID, workspaceID: "demo", status: "created", totalParts: 1, chunkSize: 4, size: 4, received: map[int]int64{}}
	store.sessions["up_legacy"] = &uploadSession{id: "up_legacy", status: "created", received: map[int]int64{}}
	store.sessions["up_workspace"] = &uploadSession{id: "up_workspace", ownerID: owner.UserID, workspaceID: "other", status: "created", received: map[int]int64{}}
	handler := uploadHTTPHandler(store)
	for _, token := range []string{guest.Token, otherToken, ""} {
		for _, operation := range []struct{ method, suffix, body string }{
			{http.MethodGet, "", ""}, {http.MethodPatch, "/parts/0", "data"}, {http.MethodPost, "/complete", `{"contentHash":"` + stringsRepeat("0", 64) + `"}`},
		} {
			response := uploadHTTPRequest(handler, token, operation.method, "/api/v1/uploads/up_owned"+operation.suffix, operation.body)
			want := http.StatusForbidden
			if token == "" {
				want = http.StatusUnauthorized
			}
			if response.Code != want {
				t.Errorf("%s %s token=%q: got %d want %d", operation.method, operation.suffix, token, response.Code, want)
			}
		}
	}
	for _, id := range []string{"up_legacy", "up_workspace"} {
		response := uploadHTTPRequest(handler, ownerToken, http.MethodGet, "/api/v1/uploads/"+id, "")
		if response.Code != http.StatusForbidden {
			t.Errorf("owner must not claim %s: got %d", id, response.Code)
		}
	}
	response := uploadHTTPRequest(handler, guest.Token, http.MethodPost, "/api/v1/uploads", `{"name":"guest.txt","size":0}`)
	if response.Code != http.StatusForbidden {
		t.Errorf("guest create: got %d", response.Code)
	}
	// Direct handlers must also fail closed when auth is configured.
	response = httptest.NewRecorder()
	store.handleCollection(response, httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(`{"name":"anonymous.txt","size":0}`)))
	if response.Code != http.StatusUnauthorized {
		t.Errorf("direct unauthenticated create: got %d", response.Code)
	}
}

type uploadFailingBackend struct {
	persistBackend
	failSnapshot bool
	failJoint    bool
}

func (b *uploadFailingBackend) saveUploadSession(session uploadSession) error {
	if b.failSnapshot {
		return errors.New("injected snapshot failure")
	}
	return b.persistBackend.saveUploadSession(session)
}

func (b *uploadFailingBackend) saveUploadWithMVPState(session uploadSession, payload []byte) error {
	if b.failJoint {
		return errors.New("injected transaction failure")
	}
	return b.persistBackend.saveUploadWithMVPState(session, payload)
}

func TestUploadSnapshotFailureDoesNotAcknowledgeCreateOrPart(t *testing.T) {
	backend := &uploadFailingBackend{persistBackend: newTestSQLiteBackend(t, ""), failSnapshot: true}
	store := newUploadStoreWithBackend(t.TempDir(), backend)
	response := httptest.NewRecorder()
	store.handleCollection(response, httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewBufferString(`{"name":"failure.txt","size":4,"chunkSize":4}`)))
	if response.Code != http.StatusInternalServerError || len(store.sessions) != 0 {
		t.Fatalf("failed create must not publish: status=%d sessions=%d", response.Code, len(store.sessions))
	}
	backend.failSnapshot = false
	view := createTestUpload(t, store, "part.txt", 4, 4)
	backend.failSnapshot = true
	response = uploadHTTPRequest(http.HandlerFunc(store.handleItem), "", http.MethodPatch, "/api/v1/uploads/"+view.ID+"/parts/0", "data")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed snapshot must not acknowledge part: %d", response.Code)
	}
	current, _ := store.get(view.ID)
	if len(current.received) != 0 || current.status != "created" {
		t.Fatalf("failed snapshot must not publish part: %+v", current)
	}
	backend.failSnapshot = false
	uploadPart(t, store, view.ID, 0, []byte("data"))
}

func TestUploadFailedPartReplacementPreservesAcknowledgedBytes(t *testing.T) {
	backend := &uploadFailingBackend{persistBackend: newTestSQLiteBackend(t, "")}
	store := newUploadStoreWithBackend(t.TempDir(), backend)
	view := createTestUpload(t, store, "replace.txt", 4, 4)
	uploadPart(t, store, view.ID, 0, []byte("data"))
	backend.failSnapshot = true
	response := uploadHTTPRequest(http.HandlerFunc(store.handleItem), "", http.MethodPatch, "/api/v1/uploads/"+view.ID+"/parts/0", "oops")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed replacement acknowledged: %d", response.Code)
	}
	current, _ := store.get(view.ID)
	content, err := os.ReadFile(filepath.Join(current.directory, "part-00000000"))
	if err != nil || string(content) != "data" {
		t.Fatalf("failed replacement lost previously acknowledged bytes: %q %v", content, err)
	}
	backend.failSnapshot = false
	hash := sha256.Sum256([]byte("data"))
	completeUpload(t, store, view.ID, hex.EncodeToString(hash[:]))
}

type uploadDelayedBackend struct {
	persistBackend
	store   *uploadStore
	once    sync.Once
	entered chan bool
	release chan struct{}
}

func (b *uploadDelayedBackend) saveUploadSession(session uploadSession) error {
	if session.status == "uploading" {
		b.once.Do(func() {
			locked := !b.store.mu.TryLock()
			if !locked {
				b.store.mu.Unlock()
			}
			b.entered <- locked
			<-b.release
		})
	}
	return b.persistBackend.saveUploadSession(session)
}

func TestUploadDelayedPartSnapshotCannotOverwriteCompletion(t *testing.T) {
	backend := &uploadDelayedBackend{persistBackend: newTestSQLiteBackend(t, ""), entered: make(chan bool, 1), release: make(chan struct{})}
	store := newUploadStoreWithBackend(t.TempDir(), backend)
	backend.store = store
	view := createTestUpload(t, store, "ordered.txt", 4, 4)
	partDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		partDone <- uploadHTTPRequest(http.HandlerFunc(store.handleItem), "", http.MethodPatch, "/api/v1/uploads/"+view.ID+"/parts/0", "data")
	}()
	locked := <-backend.entered
	hash := sha256.Sum256([]byte("data"))
	completeDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		completeDone <- uploadHTTPRequest(http.HandlerFunc(store.handleItem), "", http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+hex.EncodeToString(hash[:])+`"}`)
	}()
	if !locked {
		// Reproduce the old ordering deterministically: completion commits first,
		// then the delayed part upsert overwrites it with an uploading snapshot.
		select {
		case <-completeDone:
		case <-time.After(5 * time.Second):
			t.Error("completion blocked despite unlocked snapshot")
		}
	}
	close(backend.release)
	if response := <-partDone; response.Code != http.StatusOK {
		t.Errorf("part: %d %s", response.Code, response.Body.String())
	}
	if locked {
		select {
		case response := <-completeDone:
			if response.Code != http.StatusCreated {
				t.Errorf("complete: %d %s", response.Code, response.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatal("completion deadlocked")
		}
	}
	sessions, err := backend.loadUploadSessions()
	if err != nil || len(sessions) != 1 || sessions[0].status != "completed" || !locked {
		t.Fatalf("snapshot writes must hold uploads lock and preserve completed state: locked=%v sessions=%+v err=%v", locked, sessions, err)
	}
}

func TestUploadHTTPCompletionTransactionFailureRetainsRetry(t *testing.T) {
	store, mvp, auth := newDirectoryTestStores(t)
	backend := &uploadFailingBackend{persistBackend: store.backend}
	store.backend, mvp.backend = backend, backend
	token := directoryToken(t, auth)
	view := createDirectoryUpload(t, store, token, "retry.txt", 4, 4, "")
	uploadDirectoryPart(t, store, token, view.ID, 0, []byte("data"))
	beforeRevision := mvp.resourceRev
	backend.failJoint = true
	hash := sha256.Sum256([]byte("data"))
	response := completeDirectoryUpload(t, store, token, view.ID, hex.EncodeToString(hash[:]))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("joint failure: got %d %s", response.Code, response.Body.String())
	}
	current, _ := store.get(view.ID)
	if current.status != "uploading" || current.entryID != view.EntryID || len(current.received) != 1 {
		t.Fatalf("failed completion lost retry state: %+v", current)
	}
	if _, err := os.Stat(filepath.Join(current.directory, "part-00000000")); err != nil {
		t.Fatal(err)
	}
	if _, exists := mvp.state.Resources[view.EntryID]; exists || mvp.resourceRev != beforeRevision {
		t.Fatal("failed completion published an entry/revision")
	}
	sessions, err := backend.loadUploadSessions()
	if err != nil || len(sessions) != 1 || sessions[0].status != "uploading" {
		t.Fatalf("durable retry state: %+v %v", sessions, err)
	}
	backend.failJoint = false
	response = completeDirectoryUpload(t, store, token, view.ID, hex.EncodeToString(hash[:]))
	if response.Code != http.StatusCreated {
		t.Fatalf("retry: %d %s", response.Code, response.Body.String())
	}
	current, _ = store.get(view.ID)
	if current.entryID != view.EntryID || current.status != "completed" {
		t.Fatalf("retry changed identity: %+v", current)
	}
}

func TestUploadHTTPDeletedCompletionDoesNotReviveEntry(t *testing.T) {
	store, mvp, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)
	view := createDirectoryUpload(t, store, token, "deleted.txt", 4, 4, "")
	uploadDirectoryPart(t, store, token, view.ID, 0, []byte("data"))
	hash := sha256.Sum256([]byte("data"))
	digest := hex.EncodeToString(hash[:])
	response := completeDirectoryUpload(t, store, token, view.ID, digest)
	if response.Code != http.StatusCreated {
		t.Fatalf("complete: %d %s", response.Code, response.Body.String())
	}
	response = uploadHTTPRequest(http.HandlerFunc(mvp.handleFilesResourceItem), token, http.MethodDelete, "/api/v1/resources/"+view.EntryID, "")
	if response.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", response.Code, response.Body.String())
	}
	response = uploadHTTPRequest(uploadHTTPHandler(store), token, http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+digest+`"}`)
	if response.Code != http.StatusNotFound && response.Code != http.StatusConflict {
		t.Fatalf("deleted completion: %d %s", response.Code, response.Body.String())
	}
	if _, exists := mvp.state.Resources[view.EntryID]; exists {
		t.Fatal("deleted entry revived")
	}
}

// This seam test isolates upload-side state publication from the independently
// owned resource implementation. The HTTP integration tests above still require
// the real MVP committer and must not be replaced by this double.
type uploadContractProbe struct {
	directoryCommitter
	complete func(authPrincipal, uploadSession, persistBackend) (uploadSession, error)
}

func (*uploadContractProbe) validateUploadTarget(authPrincipal, string) error { return nil }
func (p *uploadContractProbe) completeUploadEntry(principal authPrincipal, session uploadSession, backend persistBackend) (uploadSession, error) {
	return p.complete(principal, session, backend)
}

func TestUploadHTTPAtomicContractPublicationAndRetry(t *testing.T) {
	store, mvp, auth := newDirectoryTestStores(t)
	backend := &uploadFailingBackend{persistBackend: store.backend}
	store.backend = backend
	deleted := false
	store.committer = &uploadContractProbe{directoryCommitter: mvp, complete: func(principal authPrincipal, candidate uploadSession, backend persistBackend) (uploadSession, error) {
		if store.mu.TryLock() {
			store.mu.Unlock()
			t.Error("committer called without uploads lock")
		}
		if candidate.ownerID != principal.UserID || candidate.workspaceID != principal.WorkspaceID || candidate.entryID == "" {
			t.Error("committer did not receive authenticated identity and preallocated entryId")
		}
		if candidate.status == "completed" {
			if deleted {
				return uploadSession{}, errUploadEntryNotFound
			}
			return candidate, nil
		}
		if store.sessions[candidate.id].status != "verifying" || store.sessions[candidate.id].resourceID != "" {
			t.Error("completion published before transaction")
		}
		candidate.name = "retry (2).txt"
		candidate.status = "completed"
		return candidate, backend.saveUploadWithMVPState(candidate, []byte(`{}`))
	}}
	token := directoryToken(t, auth)
	handler := uploadHTTPHandler(store)
	backend.failSnapshot = true
	response := uploadHTTPRequest(handler, token, http.MethodPost, "/api/v1/uploads", `{"name":"retry.txt","size":4,"chunkSize":4}`)
	if response.Code != http.StatusInternalServerError || len(store.sessions) != 0 {
		t.Fatalf("create snapshot failure: %d %s", response.Code, response.Body.String())
	}
	backend.failSnapshot = false
	view := createDirectoryUpload(t, store, token, "retry.txt", 4, 4, "")
	if view.EntryID == "" || view.OwnerID == "" || view.WorkspaceID != "demo" {
		t.Fatalf("missing identity: %+v", view)
	}
	backend.failSnapshot = true
	response = uploadHTTPRequest(handler, token, http.MethodPatch, "/api/v1/uploads/"+view.ID+"/parts/0", "data")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("part snapshot failure: %d", response.Code)
	}
	backend.failSnapshot = false
	uploadDirectoryPart(t, store, token, view.ID, 0, []byte("data"))
	hash := sha256.Sum256([]byte("data"))
	digest := hex.EncodeToString(hash[:])
	backend.failJoint = true
	response = uploadHTTPRequest(handler, token, http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+digest+`"}`)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("joint failure: %d", response.Code)
	}
	current, _ := store.get(view.ID)
	if current.status != "uploading" || current.entryID != view.EntryID || len(current.received) != 1 || current.name != "retry.txt" {
		t.Fatalf("failed transaction published candidate or lost retry: %+v", current)
	}
	if _, err := os.Stat(filepath.Join(current.directory, "part-00000000")); err != nil {
		t.Fatal(err)
	}
	backend.failJoint = false
	for _, want := range []int{http.StatusCreated, http.StatusOK} {
		response = uploadHTTPRequest(handler, token, http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+digest+`"}`)
		var result map[string]interface{}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != want || result["name"] != "retry (2).txt" || result["finalName"] != result["name"] || result["entryId"] != view.EntryID {
			t.Fatalf("completion protocol: %d %s", response.Code, response.Body.String())
		}
	}
	sessions, err := backend.loadUploadSessions()
	if err != nil || len(sessions) != 1 || sessions[0].status != "completed" || sessions[0].name != "retry (2).txt" || sessions[0].entryID != view.EntryID {
		t.Fatalf("completed snapshot: %+v %v", sessions, err)
	}
	response = uploadHTTPRequest(handler, token, http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+stringsRepeat("0", 64)+`"}`)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("repeated complete accepted another hash: %d", response.Code)
	}
	deleted = true
	response = uploadHTTPRequest(handler, token, http.MethodPost, "/api/v1/uploads/"+view.ID+"/complete", `{"contentHash":"`+digest+`"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("deleted entry not checked: %d", response.Code)
	}
}

func TestUploadHTTPRejectsMissingParentAtCreation(t *testing.T) {
	store, _, auth := newDirectoryTestStores(t)
	response := uploadHTTPRequest(uploadHTTPHandler(store), directoryToken(t, auth), http.MethodPost, "/api/v1/uploads", `{"name":"orphan.txt","size":0,"parentId":"missing"}`)
	if response.Code != http.StatusNotFound || len(store.sessions) != 0 {
		t.Fatalf("invalid target must not create a session: %d %s", response.Code, response.Body.String())
	}
}
