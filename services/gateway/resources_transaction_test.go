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
	"testing"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

type resourceTransactionBackend struct {
	*sqliteBackend
	failBlob, failJoint   bool
	blobCalls, jointCalls int
	beforeSave            func()
}

func (b *resourceTransactionBackend) saveMVPState(raw []byte) error {
	b.blobCalls++
	if b.beforeSave != nil {
		b.beforeSave()
	}
	if b.failBlob {
		return errors.New("injected directory save failure")
	}
	return b.sqliteBackend.saveMVPState(raw)
}

func (b *resourceTransactionBackend) saveUploadWithMVPState(snapshot uploadSession, raw []byte) error {
	b.jointCalls++
	if b.beforeSave != nil {
		b.beforeSave()
	}
	if b.failJoint {
		return errors.New("injected combined save failure")
	}
	return b.sqliteBackend.saveUploadWithMVPState(snapshot, raw)
}

func resourceStateJSON(t *testing.T, s *mvpStore) []byte {
	t.Helper()
	raw, err := json.Marshal(s.state)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func assertResourceEvents(t *testing.T, s *mvpStore, count int) {
	t.Helper()
	events := s.hub.store.Retained()
	if len(events) != count {
		t.Fatalf("events=%d, want %d", len(events), count)
	}
	for _, event := range events {
		raw, _ := json.Marshal(event.Payload)
		if event.Type != "resources.changed" || string(raw) != "{}" {
			t.Fatalf("resource event must contain no identifiers or names: %+v", event)
		}
	}
}

func TestResourceTransactionFailureDoesNotPublish(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			item := contractItem("item", "folder", "")
			item.Meta = map[string]interface{}{"label": "original"}
			s := contractStore(item)
			s.hub = newHub()
			s.state.Shares["share"] = protocol.ResourceShareLink{Token: "share", ResourceID: item.ID}
			s.state.CodeData["latest"] = "unrelated concurrent code"
			s.state.Messages["latest"] = protocol.ChatMessage{ID: "latest"}
			s.state.Jobs["latest"] = mvpJob{Ref: protocol.JobRef{ID: "latest"}}
			backend := &resourceTransactionBackend{sqliteBackend: newTestSQLiteBackend(t, "")}
			s.backend = backend
			before := resourceStateJSON(t, s)
			if err := backend.saveMVPState(before); err != nil {
				t.Fatal(err)
			}
			backend.beforeSave = func() {
				if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
					t.Error("published before durable save")
				}
				assertResourceEvents(t, s, 0)
			}
			backend.failBlob = true
			path := "/api/v1/resources/item"
			if method == http.MethodPost {
				path = "/api/v1/resources"
			}
			body := map[string]interface{}{"name": "changed", "meta": map[string]interface{}{"label": "changed"}, "acl": protocol.ResourceACL{OwnerID: "forged"}}
			w := contractRequest(s, contractPrincipal(roleMember), method, path, body)
			if w.Code != http.StatusInternalServerError {
				t.Errorf("want 500, got %d: %s", w.Code, w.Body.String())
			}
			if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
				t.Error("failed save changed live state/revision")
			}
			durable, err := backend.loadMVPState()
			if err != nil || !bytes.Equal(before, durable) {
				t.Error("failed save changed durable state")
			}
			assertResourceEvents(t, s, 0)
			backend.failBlob = false
			w = contractRequest(s, contractPrincipal(roleMember), method, path, body)
			if w.Code != http.StatusOK && w.Code != http.StatusCreated {
				t.Fatalf("retry: %d %s", w.Code, w.Body.String())
			}
			if s.resourceRev != 1 {
				t.Errorf("revision=%d", s.resourceRev)
			}
			assertResourceEvents(t, s, 1)
			durable, err = backend.loadMVPState()
			if err != nil || !bytes.Equal(durable, resourceStateJSON(t, s)) {
				t.Error("published state differs from durable candidate")
			}
			if s.state.CodeData["latest"] == "" || s.state.Messages["latest"].ID == "" || s.state.Jobs["latest"].Ref.ID == "" {
				t.Error("lost unrelated latest state")
			}
		})
	}
}

func TestResourceTransactionCreateUsesServerDefaults(t *testing.T) {
	s := contractStore()
	p := contractPrincipal(roleMember)
	w := contractRequest(s, p, http.MethodPost, "/api/v1/resources", map[string]interface{}{
		"name": "folder", "ownerId": "forged", "workspaceId": "elsewhere",
		"meta": map[string]string{"contentHash": "forged"}, "acl": protocol.ResourceACL{OwnerID: "forged"},
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	for _, item := range s.state.Resources {
		if item.OwnerID != p.UserID || item.WorkspaceID != "demo" || item.ACL.OwnerID != p.UserID || len(item.Meta) != 0 {
			t.Errorf("unsafe defaults: %+v", item)
		}
		other := contractPrincipal(roleGuest)
		other.UserID = "another"
		if !s.itemView(other, item).CanRead || s.itemView(other, item).CanWrite {
			t.Error("new folder must be workspace readable, not publicly writable")
		}
	}
}

func TestResourceTransactionFolderIgnoresClientMetadataShape(t *testing.T) {
	s := contractStore()
	w := contractRequest(s, contractPrincipal(roleMember), http.MethodPost, "/api/v1/resources", map[string]interface{}{
		"name": "folder", "meta": "ignored", "acl": "ignored", "ownerId": "ignored",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("server-managed fields must be ignored: %d %s", w.Code, w.Body.String())
	}
}

func TestResourceTransactionMoveChecksAllDescendants(t *testing.T) {
	for _, mode := range []string{"private", "non-file", "foreign-workspace"} {
		t.Run(mode, func(t *testing.T) {
			leaf := contractItem("leaf", "file", "child")
			switch mode {
			case "private":
				leaf.ACL.Grants[0].Actions = []string{"resource.read"}
			case "non-file":
				leaf.Type = "code.project"
			case "foreign-workspace":
				leaf.WorkspaceID = "elsewhere"
			}
			s := contractStore(contractItem("root", "folder", ""), contractItem("target", "folder", ""), contractItem("child", "folder", "root"), leaf)
			s.hub = newHub()
			before := resourceStateJSON(t, s)
			w := contractRequest(s, contractPrincipal(roleMember), http.MethodPatch, "/api/v1/resources/root", map[string]string{"parentId": "target"})
			if w.Code != http.StatusForbidden {
				t.Errorf("want 403, got %d %s", w.Code, w.Body.String())
			}
			if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
				t.Error("denied move changed state")
			}
			assertResourceEvents(t, s, 0)
		})
	}
}

func TestResourceTransactionDeleteCleansOnlyRelatedShares(t *testing.T) {
	s := contractStore(contractItem("root", "folder", ""), contractItem("file", "file", "root"), contractItem("sibling", "file", ""))
	s.hub = newHub()
	for _, id := range []string{"root", "file", "sibling"} {
		s.state.Shares[id] = protocol.ResourceShareLink{Token: id, ResourceID: id}
	}
	w := contractRequest(s, contractPrincipal(roleMember), http.MethodDelete, "/api/v1/resources/root?recursive=true", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	if len(s.state.Shares) != 1 || s.state.Shares["sibling"].ResourceID != "sibling" {
		t.Errorf("shares not cleaned safely: %+v", s.state.Shares)
	}
	assertResourceEvents(t, s, 1)
}

func TestResourceTransactionDeleteRetainsSharedCASObject(t *testing.T) {
	root := t.TempDir()
	content := []byte("shared bytes")
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	file := contractItem("file", "file", "")
	file.Meta = map[string]interface{}{"contentHash": hash}
	sibling := contractItem("sibling", "file", "")
	sibling.Meta = file.Meta
	s := contractStore(file, sibling)
	s.content = newContentStore(filepath.Join(root, "objects"))
	temporary := filepath.Join(root, "upload")
	if err := os.WriteFile(temporary, content, 0600); err != nil {
		t.Fatal(err)
	}
	object, err := s.content.commit(temporary, hash)
	if err != nil {
		t.Fatal(err)
	}
	w := contractRequest(s, contractPrincipal(roleMember), http.MethodDelete, "/api/v1/resources/file", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	stored, err := os.ReadFile(object)
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatalf("delete removed shared CAS bytes: %v", err)
	}
	if s.state.Resources[sibling.ID].Meta["contentHash"] != hash {
		t.Error("sibling content changed")
	}
}

func TestResourceTransactionLegacyUnsupportedMethods(t *testing.T) {
	for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodDelete, http.MethodHead} {
		s := contractStore(contractItem("legacy", "code.project", ""))
		w := httptest.NewRecorder()
		s.handleFilesResourceItem(w, httptest.NewRequest(method, "/api/v1/resources/legacy", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: want 405, got %d", method, w.Code)
		}
	}
}

func TestResourceTransactionCombinedUploadRetry(t *testing.T) {
	uploads, s, auth := newDirectoryTestStores(t)
	token := directoryToken(t, auth)
	backend := &resourceTransactionBackend{sqliteBackend: uploads.backend.(*sqliteBackend)}
	uploads.backend, s.backend = backend, backend
	view := createDirectoryUpload(t, uploads, token, "report.txt", 4, 4, "")
	uploadDirectoryPart(t, uploads, token, view.ID, 0, []byte("data"))
	digest := sha256.Sum256([]byte("data"))
	hash := hex.EncodeToString(digest[:])
	s.state.CodeData["latest"] = "preserve me"
	conflict := contractItem("conflict", "file", "")
	conflict.Name = "report.txt"
	s.state.Resources[conflict.ID] = conflict
	before := resourceStateJSON(t, s)
	if err := backend.saveMVPState(before); err != nil {
		t.Fatal(err)
	}
	backend.beforeSave = func() {
		if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
			t.Error("upload published before combined commit")
		}
		assertResourceEvents(t, s, 0)
	}
	backend.failJoint = true
	w := completeDirectoryUpload(t, uploads, token, view.ID, hash)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("failed combined commit: %d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
		t.Error("failed combined commit published directory")
	}
	current, _ := uploads.get(view.ID)
	if current.status != "uploading" || current.entryID != view.EntryID {
		t.Fatalf("upload not retryable: %+v", current)
	}
	durable, _ := backend.loadMVPState()
	if !bytes.Equal(before, durable) {
		t.Error("failed combined commit changed durable directory")
	}
	assertResourceEvents(t, s, 0)
	backend.failJoint = false
	w = completeDirectoryUpload(t, uploads, token, view.ID, hash)
	if w.Code != http.StatusCreated {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
	backend.beforeSave = nil
	if s.state.Resources[view.EntryID].Name != "report (2).txt" || s.resourceRev != 1 || s.state.CodeData["latest"] != "preserve me" {
		t.Error("incorrect committed candidate")
	}
	stored, err := backend.loadUploadSessions()
	if err != nil || len(stored) != 1 || stored[0].status != "completed" || stored[0].name != "report (2).txt" || stored[0].entryID != view.EntryID {
		t.Fatalf("bad durable completed snapshot: %+v %v", stored, err)
	}
	durable, _ = backend.loadMVPState()
	if !bytes.Equal(durable, resourceStateJSON(t, s)) {
		t.Error("combined commit lost current full state")
	}
	assertResourceEvents(t, s, 1)
	calls := backend.jointCalls
	w = completeDirectoryUpload(t, uploads, token, view.ID, hash)
	if w.Code != http.StatusOK || backend.jointCalls != calls || s.resourceRev != 1 {
		t.Errorf("repeat completion must be lookup-only: %d %s", w.Code, w.Body.String())
	}
	assertResourceEvents(t, s, 1)
	delete(s.state.Resources, view.EntryID)
	w = completeDirectoryUpload(t, uploads, token, view.ID, hash)
	if w.Code != http.StatusNotFound {
		t.Errorf("deleted completion must return 404: %d %s", w.Code, w.Body.String())
	}
	if _, ok := s.state.Resources[view.EntryID]; ok {
		t.Error("completed entry resurrected")
	}
	assertResourceEvents(t, s, 1)
}

func TestResourceTransactionOtherSavesFailClosed(t *testing.T) {
	for _, operation := range []string{"get-file", "get-legacy", "patch-legacy", "share"} {
		t.Run(operation, func(t *testing.T) {
			item := contractItem("item", "file", "")
			if operation == "get-legacy" || operation == "patch-legacy" {
				item.Type = "code.project"
			}
			s := contractStore(item)
			s.hub = newHub()
			s.backend = &resourceTransactionBackend{sqliteBackend: newTestSQLiteBackend(t, ""), failBlob: true}
			before := resourceStateJSON(t, s)
			w := httptest.NewRecorder()
			p := contractPrincipal(roleMember)
			switch operation {
			case "get-file":
				s.handleFilesGet(w, httptest.NewRequest(http.MethodGet, "/", nil), item.ID, p)
			case "get-legacy":
				s.handleLegacyResourceItem(w, httptest.NewRequest(http.MethodGet, "/", nil), item.ID, p)
			case "patch-legacy":
				s.handleLegacyResourceItem(w, httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"name":"changed","acl":{"ownerId":"forged","grants":[]}}`)), item.ID, p)
			case "share":
				s.handleResourceShare(w, httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{}`)), item.ID, p)
			}
			if w.Code != http.StatusInternalServerError {
				t.Errorf("want 500, got %d", w.Code)
			}
			if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
				t.Error("failed resource save published state")
			}
			assertResourceEvents(t, s, 0)
		})
	}
}

func TestResourceTransactionUploadSpecialOwnerAuthorization(t *testing.T) {
	for _, ownerID := range []string{"", "system"} {
		for _, restrictedID := range []string{"parent", "target"} {
			for _, access := range []struct {
				name, role string
				grant      bool
				allowed    bool
			}{
				{"member-denied", roleMember, false, false},
				{"guest-denied", roleGuest, false, false},
				{"member-granted", roleMember, true, true},
				{"admin", roleAdmin, false, true},
			} {
				t.Run(ownerID+"/"+restrictedID+"/"+access.name, func(t *testing.T) {
					s := contractStore(contractItem("parent", "folder", ""), contractItem("target", "folder", "parent"))
					s.hub = newHub()
					p := contractPrincipal(access.role)
					restricted := s.state.Resources[restrictedID]
					restricted.OwnerID = ownerID
					s.state.Resources[restricted.ID] = restricted
					// Start with a writable target, then remove grants before completion.
					if err := s.validateUploadTarget(contractPrincipal(roleMember), "target"); err != nil {
						t.Fatal(err)
					}
					restricted.ACL = protocol.ResourceACL{}
					if restrictedID == "target" {
						restricted.ACL.Grants = []protocol.ResourceGrant{{Subject: "*", Actions: []string{"resource.read"}}}
					}
					if access.grant {
						restricted.ACL.Grants = append(restricted.ACL.Grants, protocol.ResourceGrant{Subject: roleMember, Actions: []string{"resource.read", "resource.write"}})
					}
					s.state.Resources[restricted.ID] = restricted
					before := resourceStateJSON(t, s)
					var want error
					if !access.allowed {
						want = errUploadForbidden
					}
					if err := s.validateUploadTarget(p, "target"); !errors.Is(err, want) {
						t.Errorf("validate target: want %v, got %v", want, err)
					}
					snapshot := uploadSession{id: "up_test", entryID: "res_test", ownerID: p.UserID, workspaceID: p.WorkspaceID, status: "verifying", parentID: "target", name: "upload.txt", contentHash: stringsRepeat("a", 64)}
					completed, err := s.completeUploadEntry(p, snapshot, memoryBackend{})
					if !errors.Is(err, want) {
						t.Errorf("complete upload: want %v, got %v", want, err)
					}
					if access.allowed {
						if completed.status != "completed" || s.state.Resources[snapshot.entryID].ParentID != "target" {
							t.Error("authorized upload did not publish entry")
						}
					} else {
						if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
							t.Error("denied upload changed state/revision")
						}
						assertResourceEvents(t, s, 0)
					}
				})
			}
		}
	}
}

func TestResourceTransactionUploadAuthorizationRechecked(t *testing.T) {
	for _, mode := range []string{"role", "workspace", "owner", "hidden-ancestor", "target-readonly", "target-missing", "target-file"} {
		t.Run(mode, func(t *testing.T) {
			parent := contractItem("parent", "folder", "")
			target := contractItem("target", "folder", "parent")
			s := contractStore(parent, target)
			s.hub = newHub()
			p := contractPrincipal(roleMember)
			committer := interface{}(s).(atomicDirectoryCommitter)
			if err := committer.validateUploadTarget(p, "target"); err != nil {
				t.Fatal(err)
			}
			snapshot := uploadSession{id: "up_test", entryID: "res_test", ownerID: p.UserID, workspaceID: p.WorkspaceID, status: "verifying", parentID: "target", name: "upload.txt", contentHash: stringsRepeat("a", 64)}
			want := errUploadForbidden
			switch mode {
			case "role":
				p.Role = roleGuest
			case "workspace":
				p.WorkspaceID = "elsewhere"
			case "owner":
				p.UserID = "another"
			case "hidden-ancestor":
				parent.ACL = protocol.ResourceACL{}
				s.state.Resources[parent.ID] = parent
			case "target-readonly":
				target.ACL.Grants[0].Actions = []string{"resource.read"}
				s.state.Resources[target.ID] = target
			case "target-missing":
				delete(s.state.Resources, target.ID)
				want = errUploadTargetNotFound
			case "target-file":
				target.Type = "file"
				s.state.Resources[target.ID] = target
				want = errUploadTargetInvalid
			}
			before := resourceStateJSON(t, s)
			_, err := committer.completeUploadEntry(p, snapshot, memoryBackend{})
			if !errors.Is(err, want) {
				t.Errorf("want %v, got %v", want, err)
			}
			if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
				t.Error("denied upload changed state")
			}
			assertResourceEvents(t, s, 0)
		})
	}
}

func TestResourceTransactionCompletedUploadIdentity(t *testing.T) {
	for _, mode := range []string{"owner", "workspace", "upload-id", "content-hash", "ancestor"} {
		t.Run(mode, func(t *testing.T) {
			p := contractPrincipal(roleMember)
			parent := contractItem("parent", "folder", "")
			item := contractItem("entry", "file", "parent")
			item.OwnerID = p.UserID
			item.Meta = map[string]interface{}{"uploadId": "up_test", "contentHash": stringsRepeat("a", 64)}
			snapshot := uploadSession{id: "up_test", entryID: item.ID, ownerID: p.UserID, workspaceID: p.WorkspaceID, status: "completed", contentHash: stringsRepeat("a", 64)}
			switch mode {
			case "owner":
				item.OwnerID = "another"
			case "workspace":
				item.WorkspaceID = "elsewhere"
			case "upload-id":
				item.Meta["uploadId"] = "another"
			case "content-hash":
				item.Meta["contentHash"] = stringsRepeat("b", 64)
			case "ancestor":
				parent.ACL = protocol.ResourceACL{}
			}
			s := contractStore(parent, item)
			s.hub = newHub()
			committer := interface{}(s).(atomicDirectoryCommitter)
			before := resourceStateJSON(t, s)
			_, err := committer.completeUploadEntry(p, snapshot, memoryBackend{})
			if !errors.Is(err, errUploadForbidden) {
				t.Errorf("want forbidden, got %v", err)
			}
			if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
				t.Error("denied completed lookup changed state")
			}
			assertResourceEvents(t, s, 0)
		})
	}
}

func TestResourceTransactionDownloadRequiresReadableReference(t *testing.T) {
	for _, mode := range []string{"private", "hidden-ancestor", "empty-owned-ancestor", "system-owned-ancestor", "orphan", "foreign-workspace", "readable", "readable-duplicate", "legacy", "artifact-readable", "artifact-private", "artifact-missing-job"} {
		t.Run(mode, func(t *testing.T) {
			content := []byte("private bytes")
			digest := sha256.Sum256(content)
			hash := hex.EncodeToString(digest[:])
			parent := contractItem("parent", "folder", "")
			file := contractItem("file", "file", "parent")
			file.Meta = map[string]interface{}{"contentHash": hash}
			switch mode {
			case "private", "legacy", "readable-duplicate", "artifact-readable", "artifact-private", "artifact-missing-job":
				file.ACL = protocol.ResourceACL{}
			case "hidden-ancestor", "empty-owned-ancestor", "system-owned-ancestor":
				parent.ACL = protocol.ResourceACL{}
				if mode == "empty-owned-ancestor" {
					parent.OwnerID = ""
				} else if mode == "system-owned-ancestor" {
					parent.OwnerID = "system"
				}
			case "orphan":
				file.ParentID = "missing"
			case "foreign-workspace":
				file.WorkspaceID = "elsewhere"
			}
			s := contractStore(parent, file)
			if mode == "artifact-readable" || mode == "artifact-private" || mode == "artifact-missing-job" {
				project := contractItem("project", "code.project", "")
				if mode == "artifact-private" {
					project.ACL = protocol.ResourceACL{}
				}
				s.state.Resources[project.ID] = project
				if mode != "artifact-missing-job" {
					s.state.Jobs["job"] = mvpJob{Ref: protocol.JobRef{ID: "job"}, Spec: protocol.JobSpec{ProjectID: "project"}}
				}
				s.state.Artifacts["artifact"] = protocol.JobArtifact{ID: "artifact", JobID: "job", ContentHash: hash, ResourceID: "sha256:" + hash}
			}
			if mode == "readable-duplicate" {
				duplicate := contractItem("duplicate", "file", "")
				duplicate.Meta = file.Meta
				s.state.Resources[duplicate.ID] = duplicate
			}
			if mode == "legacy" {
				// Use the persisted wire shape; startup owns initialization of this frozen map.
				if err := json.Unmarshal([]byte(`{"legacyReadableHashes":{"`+hash+`":true},"legacyFilesInitialized":true}`), &s.state); err != nil {
					t.Fatal(err)
				}
			}
			root := t.TempDir()
			s.content = newContentStore(filepath.Join(root, "objects"))
			temporary := filepath.Join(root, "content")
			if err := os.WriteFile(temporary, content, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.content.commit(temporary, hash); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"file", "sha256:" + hash} {
				for _, method := range []string{http.MethodGet, http.MethodHead} {
					w := httptest.NewRecorder()
					s.handleAuthorizedDownload(w, httptest.NewRequest(method, "/api/v1/files/"+id+"/content", nil))
					allowed := mode == "readable" || (id != "file" && (mode == "readable-duplicate" || mode == "legacy" || mode == "artifact-readable"))
					want := http.StatusForbidden
					if allowed {
						want = http.StatusOK
					}
					if w.Code != want {
						t.Errorf("%s %s: want %d got %d", method, id, want, w.Code)
					}
				}
			}
			w := httptest.NewRecorder()
			s.handleLegacyListResources(w, httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil), contractPrincipal(roleMember))
			var page struct {
				Items []protocol.ResourceRecord `json:"items"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			for _, item := range page.Items {
				if item.ID == file.ID && mode != "readable" {
					t.Error("legacy list leaked inaccessible file")
				}
			}
		})
	}
}
