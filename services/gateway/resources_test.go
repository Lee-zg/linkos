package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func resourcesRequest(t *testing.T, server *httptest.Server, token, method, path string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var raw bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&raw).Encode(body)
	}
	req := httptest.NewRequest(method, path, &raw)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	return rec
}

func createFolder(t *testing.T, server *httptest.Server, token, name, parentID string) protocol.ResourceRecord {
	t.Helper()
	body := map[string]interface{}{"type": "folder", "name": name}
	if parentID != "" {
		body["parentId"] = parentID
	}
	rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create folder %q: status=%d body=%s", name, rec.Code, rec.Body.String())
	}
	var res protocol.ResourceRecord
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal resource: %v", err)
	}
	return res
}

func listFiles(t *testing.T, server *httptest.Server, token, query string) (items []protocol.ResourceRecord, nextCursor string) {
	t.Helper()
	rec := resourcesRequest(t, server, token, http.MethodGet, "/api/v1/resources"+query, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list files %q: status=%d body=%s", query, rec.Code, rec.Body.String())
	}
	var page struct {
		Items      []protocol.ResourceRecord `json:"items"`
		NextCursor string                    `json:"nextCursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("unmarshal page: %v", err)
	}
	return page.Items, page.NextCursor
}

// --- scope=files root listing ---

func TestResourceListScopeFilesRootShowsOnlyFileEntries(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Docs", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	if len(items) != 1 || items[0].Name != "Docs" {
		t.Fatalf("expected root folder Docs, got %+v", items)
	}
	for _, it := range items {
		if it.Type != "folder" && it.Type != "file" {
			t.Fatalf("unexpected type %q in files listing", it.Type)
		}
	}
}

func TestResourceListScopeFilesRootExcludesNonFileResources(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "MyFolder", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	for _, it := range items {
		if it.ID == "project_gateway" {
			t.Fatal("code.project should not appear in files scope listing")
		}
	}
}

// --- nested navigation ---

func TestResourceListNestedDirectory(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	parent := createFolder(t, server, token, "Parent", "")
	child := createFolder(t, server, token, "Child", parent.ID)

	items, _ := listFiles(t, server, token, "?scope=files&parentId="+parent.ID)
	if len(items) != 1 || items[0].ID != child.ID {
		t.Fatalf("expected child, got %+v", items)
	}

	rootItems, _ := listFiles(t, server, token, "?scope=files&parentId=")
	for _, it := range rootItems {
		if it.ID == child.ID {
			t.Fatal("child should not appear in root listing")
		}
	}
}

// --- name validation ---

func TestResourceCreateRejectsInvalidNames(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	invalidNames := []string{"", "  ", ".", "..", "a/b", "a\\b", "file\x00name", strings.Repeat("x", 256)}
	for _, name := range invalidNames {
		rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": name})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("name %q: expected 400, got %d body=%s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestResourceCreateAcceptsValidNames(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	validNames := []string{"hello", "a b", "文件", strings.Repeat("x", 255)}
	for _, name := range validNames {
		rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": name})
		if rec.Code != http.StatusCreated {
			t.Errorf("name %q: expected 201, got %d body=%s", name, rec.Code, rec.Body.String())
		}
	}
}

// --- same-name conflict ---

func TestResourceCreateSameNameConflict(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Docs", "")
	rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "Docs"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceCreateCaseInsensitiveConflict(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Docs", "")
	rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "docs"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for case-insensitive duplicate, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceCreateSameNameInDifferentParents(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	a := createFolder(t, server, token, "A", "")
	b := createFolder(t, server, token, "B", "")

	recA := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "Child", "parentId": a.ID})
	if recA.Code != http.StatusCreated {
		t.Fatalf("create in A: status=%d body=%s", recA.Code, recA.Body.String())
	}
	recB := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "Child", "parentId": b.ID})
	if recB.Code != http.StatusCreated {
		t.Fatalf("create in B: status=%d body=%s", recB.Code, recB.Body.String())
	}
}

// --- rename ---

func TestResourceRenameCaseOnlyAllowed(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "Docs", "")
	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"name": "DOCS"})
	if rec.Code != http.StatusOK {
		t.Fatalf("case-only rename: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated protocol.ResourceRecord
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.Name != "DOCS" {
		t.Fatalf("expected name DOCS, got %q", updated.Name)
	}
}

func TestResourceRenameToExistingNameConflict(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "A", "")
	b := createFolder(t, server, token, "B", "")

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+b.ID, map[string]interface{}{"name": "A"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("rename conflict: expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceRenameRejectsInvalidName(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "Docs", "")
	for _, name := range []string{".", "..", "a/b", ""} {
		rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"name": name})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("rename to %q: expected 400, got %d", name, rec.Code)
		}
	}
}

// --- move ---

func TestResourceMoveToFolder(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	target := createFolder(t, server, token, "Target", "")
	child := createFolder(t, server, token, "Child", "")

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+child.ID, map[string]interface{}{"parentId": target.ID})
	if rec.Code != http.StatusOK {
		t.Fatalf("move: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated protocol.ResourceRecord
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.ParentID != target.ID {
		t.Fatalf("expected parentId %q, got %q", target.ID, updated.ParentID)
	}
	if updated.Name != "Child" {
		t.Fatalf("move should not change name, got %q", updated.Name)
	}
}

func TestResourceMoveToRoot(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	parent := createFolder(t, server, token, "Parent", "")
	child := createFolder(t, server, token, "Child", parent.ID)

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+child.ID, map[string]interface{}{"parentId": ""})
	if rec.Code != http.StatusOK {
		t.Fatalf("move to root: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated protocol.ResourceRecord
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.ParentID != "" {
		t.Fatalf("expected empty parentId, got %q", updated.ParentID)
	}
}

func TestResourceMoveIntoSelfRejected(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "Folder", "")
	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"parentId": folder.ID})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("move into self: expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceMoveIntoDescendantRejected(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	grandparent := createFolder(t, server, token, "GP", "")
	parent := createFolder(t, server, token, "P", grandparent.ID)
	child := createFolder(t, server, token, "C", parent.ID)

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+grandparent.ID, map[string]interface{}{"parentId": child.ID})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("move into descendant: expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceMoveToNonexistentParentRejected(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "Folder", "")
	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"parentId": "res_nonexistent"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("move to nonexistent: expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceMoveToNonFolderRejected(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "Folder", "")
	codeProject := "project_gateway"

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"parentId": codeProject})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("move to non-folder: expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestResourceMoveNameConflict(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	target := createFolder(t, server, token, "Target", "")
	createFolder(t, server, token, "Existing", target.ID)
	mover := createFolder(t, server, token, "Existing", "")

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+mover.ID, map[string]interface{}{"parentId": target.ID})
	if rec.Code != http.StatusConflict {
		t.Fatalf("move conflict: expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- delete ---

func TestResourceDeleteEmptyFolder(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	folder := createFolder(t, server, token, "ToDelete", "")
	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/"+folder.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	for _, it := range items {
		if it.ID == folder.ID {
			t.Fatal("deleted folder still appears in listing")
		}
	}
}

func TestResourceDeleteNonEmptyFolderRequiresRecursive(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	parent := createFolder(t, server, token, "Parent", "")
	createFolder(t, server, token, "Child", parent.ID)

	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/"+parent.ID, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("non-empty delete without recursive: expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	found := false
	for _, it := range items {
		if it.ID == parent.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("parent should still exist after failed non-recursive delete")
	}
}

func TestResourceDeleteRecursive(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	grandparent := createFolder(t, server, token, "GP", "")
	parent := createFolder(t, server, token, "P", grandparent.ID)
	createFolder(t, server, token, "C", parent.ID)

	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/"+grandparent.ID+"?recursive=true", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recursive delete: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	for _, it := range items {
		if it.ID == grandparent.ID || it.ID == parent.ID {
			t.Fatal("deleted items still appear in listing")
		}
	}
}

func TestResourceDeleteNonexistentReturns404(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/res_nonexistent", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete nonexistent: expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- search & sort & pagination ---

func TestResourceListSearchByName(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Alpha", "")
	createFolder(t, server, token, "Beta", "")
	createFolder(t, server, token, "Alphabet", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=&q=alpha")
	if len(items) != 2 {
		t.Fatalf("expected 2 results for 'alpha', got %d: %+v", len(items), items)
	}
}

func TestResourceListSortByName(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Banana", "")
	createFolder(t, server, token, "Apple", "")
	createFolder(t, server, token, "Cherry", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=&sortBy=name&sortOrder=asc")
	if len(items) < 3 {
		t.Fatalf("expected at least 3 items, got %d", len(items))
	}
	if items[0].Name != "Apple" || items[1].Name != "Banana" || items[2].Name != "Cherry" {
		t.Fatalf("unexpected sort order: %s, %s, %s", items[0].Name, items[1].Name, items[2].Name)
	}
}

func TestResourceListSortByNameDesc(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Banana", "")
	createFolder(t, server, token, "Apple", "")
	createFolder(t, server, token, "Cherry", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=&sortBy=name&sortOrder=desc")
	if len(items) < 3 {
		t.Fatalf("expected at least 3 items, got %d", len(items))
	}
	if items[0].Name != "Cherry" || items[1].Name != "Banana" || items[2].Name != "Apple" {
		t.Fatalf("unexpected desc sort order: %s, %s, %s", items[0].Name, items[1].Name, items[2].Name)
	}
}

func TestResourceListFoldersFirst(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Zeta", "")

	items, _ := listFiles(t, server, token, "?scope=files&parentId=&sortBy=name&sortOrder=asc")
	if len(items) == 0 || items[0].Type != "folder" {
		t.Fatalf("folders should come first, got %+v", items)
	}
}

func TestResourceListPagination(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	for i := 0; i < 5; i++ {
		createFolder(t, server, token, fmt.Sprintf("Folder%02d", i), "")
	}

	page1, cursor := listFiles(t, server, token, "?scope=files&parentId=&limit=2&sortBy=name&sortOrder=asc")
	if len(page1) != 2 {
		t.Fatalf("expected 2 items in page 1, got %d", len(page1))
	}
	if cursor == "" {
		t.Fatal("expected nextCursor for page 1")
	}

	page2, cursor2 := listFiles(t, server, token, "?scope=files&parentId=&limit=2&sortBy=name&sortOrder=asc&cursor="+url.QueryEscape(cursor))
	if len(page2) != 2 {
		t.Fatalf("expected 2 items in page 2, got %d", len(page2))
	}
	if page1[1].ID == page2[0].ID {
		t.Fatal("page 2 should not overlap with page 1")
	}

	page3, _ := listFiles(t, server, token, "?scope=files&parentId=&limit=2&sortBy=name&sortOrder=asc&cursor="+url.QueryEscape(cursor2))
	if len(page3) != 1 {
		t.Fatalf("expected 1 item in page 3, got %d", len(page3))
	}
}

// --- method not allowed ---

func TestResourceCollectionMethodNotAllowed(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := resourcesRequest(t, server, token, method, "/api/v1/resources", nil)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /api/v1/resources: expected 405, got %d", method, rec.Code)
		}
	}
}

// --- parent must be folder ---

func TestResourceCreateInNonFolderRejected(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	rec := resourcesRequest(t, server, token, http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "folder", "name": "Child", "parentId": "project_gateway"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create in non-folder: expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- capabilities ---

func TestResourceListIncludesCapabilities(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Docs", "")

	var page struct {
		Items []map[string]interface{} `json:"items"`
	}
	rec := resourcesRequest(t, server, token, http.MethodGet, "/api/v1/resources?scope=files&parentId=", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &page)
	if len(page.Items) == 0 {
		t.Fatal("expected items")
	}
	for _, field := range []string{"canRead", "canWrite", "canCreateChild"} {
		if _, ok := page.Items[0][field]; !ok {
			t.Fatalf("missing capability field %q", field)
		}
	}
}

// --- rename + move in same request ---

func TestResourceRenameAndMoveSimultaneously(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	target := createFolder(t, server, token, "Target", "")
	folder := createFolder(t, server, token, "Original", "")

	rec := resourcesRequest(t, server, token, http.MethodPatch, "/api/v1/resources/"+folder.ID, map[string]interface{}{"name": "Renamed", "parentId": target.ID})
	if rec.Code != http.StatusOK {
		t.Fatalf("rename+move: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated protocol.ResourceRecord
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.Name != "Renamed" || updated.ParentID != target.ID {
		t.Fatalf("expected Renamed in Target, got %q in %q", updated.Name, updated.ParentID)
	}
}

// --- delete does not affect sibling with same content ---

func TestResourceDeleteDoesNotAffectSiblings(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	parent := createFolder(t, server, token, "Parent", "")
	sibling := createFolder(t, server, token, "Sibling", "")
	createFolder(t, server, token, "Child", parent.ID)

	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/"+parent.ID+"?recursive=true", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete parent: expected 200, got %d", rec.Code)
	}

	items, _ := listFiles(t, server, token, "?scope=files&parentId=")
	found := false
	for _, it := range items {
		if it.ID == sibling.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("sibling should still exist after deleting parent")
	}
}

// --- recent files ---

func TestResourceListRecentFiles(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	createFolder(t, server, token, "Folder1", "")
	createFolder(t, server, token, "Folder2", "")

	rec := resourcesRequest(t, server, token, http.MethodGet, "/api/v1/resources?scope=files&recent=true", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recent: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items []protocol.ResourceRecord `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &page)
	if len(page.Items) != 0 {
		t.Fatalf("recent must exclude folders, got %+v", page.Items)
	}
}

// --- recursive delete subtree pre-check ---

func TestResourceRecursiveDeleteSubtreePreCheck(t *testing.T) {
	server, auth := newMVPTestServer(t)
	defer server.Close()
	token := mvpAdminToken(t, auth)

	root := createFolder(t, server, token, "Root", "")
	createFolder(t, server, token, "A", root.ID)
	createFolder(t, server, token, "B", root.ID)

	rec := resourcesRequest(t, server, token, http.MethodDelete, "/api/v1/resources/"+root.ID+"?recursive=true", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recursive delete: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	allItems, _ := listFiles(t, server, token, "?scope=files&parentId=")
	for _, it := range allItems {
		if it.ID == root.ID {
			t.Fatal("root should be deleted")
		}
	}
}

// Contract fixtures exercise the real handlers with explicit identities and
// deterministic directory records, without touching on-disk or live data.
func contractStore(items ...protocol.ResourceRecord) *mvpStore {
	s := newMVPStore(memoryBackend{}, nil)
	s.state.Resources = make(map[string]protocol.ResourceRecord)
	for _, item := range items {
		s.state.Resources[item.ID] = item
	}
	return s
}

func contractItem(id, kind, parent string) protocol.ResourceRecord {
	return protocol.ResourceRecord{
		ID: id, Name: id, Type: kind, ParentID: parent, WorkspaceID: "demo",
		OwnerID: "other", UpdatedAt: "2026-01-01T00:00:00Z",
		ACL: protocol.ResourceACL{Grants: []protocol.ResourceGrant{{Subject: "*", Actions: []string{"resource.read", "resource.write"}}}},
	}
}

func contractPrincipal(role string) authPrincipal {
	return authPrincipal{UserID: "reader", WorkspaceID: "demo", Role: role, Status: accessStatusActive}
}

func TestFileResourceAllowsExplicitPermissions(t *testing.T) {
	for _, ownerID := range []string{"", "system", "other", "reader"} {
		for _, tc := range []struct {
			name, role, userID, subject, grantedAction string
			granted                                    bool
		}{
			{"member-without-grant", roleMember, "reader", "", "", false},
			{"guest-without-grant", roleGuest, "reader", "", "", false},
			{"empty-principal", roleMember, "", "", "", false},
			{"system-principal", roleMember, "system", "", "", false},
			{"user-grant", roleMember, "reader", "reader", "resource.write", true},
			{"role-grant", roleMember, "reader", roleMember, "resource.write", true},
			{"wildcard-subject", roleMember, "reader", "*", "resource.write", true},
			{"wildcard-action", roleMember, "reader", "reader", "*", true},
			{"unrelated-subject", roleMember, "reader", "someone-else", "*", false},
			{"wrong-action", roleMember, "reader", "reader", "code.read", false},
			{"guest-with-wildcard", roleGuest, "reader", "*", "*", true},
			{"admin", roleAdmin, "reader", "", "", false},
			{"owner-role", roleOwner, "reader", "", "", false},
		} {
			t.Run(fmt.Sprintf("owner=%q/%s", ownerID, tc.name), func(t *testing.T) {
				item := contractItem("item", "folder", "")
				item.OwnerID, item.ACL = ownerID, protocol.ResourceACL{}
				if tc.subject != "" {
					item.ACL.Grants = []protocol.ResourceGrant{{Subject: tc.subject, Actions: []string{tc.grantedAction}}}
				}
				p := contractPrincipal(tc.role)
				p.UserID = tc.userID
				for _, action := range []string{"resource.read", "resource.write"} {
					privileged := tc.role == roleAdmin || tc.role == roleOwner || (ownerID != "" && ownerID != "system" && ownerID == p.UserID)
					granted := tc.granted && (tc.grantedAction == action || tc.grantedAction == "*")
					want := (action != "resource.write" || tc.role != roleGuest) && (privileged || granted)
					if got := fileResourceAllows(p, item, action); got != want {
						t.Errorf("%s: want %t, got %t", action, want, got)
					}
					foreign := item
					foreign.WorkspaceID = "elsewhere"
					if fileResourceAllows(p, foreign, action) {
						t.Error("foreign item bypassed workspace gate")
					}
					foreignPrincipal := p
					foreignPrincipal.WorkspaceID = "elsewhere"
					if fileResourceAllows(foreignPrincipal, item, action) {
						t.Error("foreign principal bypassed workspace gate")
					}
				}
			})
		}
	}
}

func contractRequest(s *mvpStore, principal authPrincipal, method, path string, body interface{}) *httptest.ResponseRecorder {
	var raw bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&raw).Encode(body)
	}
	r := httptest.NewRequest(method, path, &raw)
	w := httptest.NewRecorder()
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/resources/")
	switch method {
	case http.MethodGet:
		if r.URL.Path == "/api/v1/resources" {
			s.handleFilesList(w, r, principal)
		} else {
			s.handleFilesGet(w, r, id, principal)
		}
	case http.MethodPost:
		s.handleFilesCreate(w, r, principal)
	case http.MethodPatch:
		s.handleFilesPatch(w, r, id, principal)
	case http.MethodDelete:
		s.handleFilesDelete(w, r, id, principal)
	}
	return w
}

type contractPage struct {
	Items      []fileItemView `json:"items"`
	NextCursor string         `json:"nextCursor"`
	Total      int            `json:"total"`
	Ancestors  []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"ancestors"`
	CanRead        bool `json:"canRead"`
	CanWrite       bool `json:"canWrite"`
	CanCreateChild bool `json:"canCreateChild"`
}

func readContractPage(t *testing.T, s *mvpStore, principal authPrincipal, query string) contractPage {
	t.Helper()
	w := contractRequest(s, principal, http.MethodGet, "/api/v1/resources?scope=files&"+query, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list: status=%d body=%s", w.Code, w.Body.String())
	}
	var page contractPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &fields)
	for _, key := range []string{"items", "nextCursor", "total", "ancestors", "canRead", "canWrite", "canCreateChild"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("missing page field %s", key)
		}
	}
	if page.Items == nil || page.Ancestors == nil {
		t.Error("items and ancestors must be arrays, not null")
	}
	return page
}

func TestFilesContractParentValidation(t *testing.T) {
	private := contractItem("private", "folder", "")
	private.ACL = protocol.ResourceACL{}
	nested := contractItem("nested", "folder", private.ID)
	file := contractItem("file", "file", "")
	for _, tc := range []struct {
		parent string
		status int
	}{
		{"missing", http.StatusNotFound}, {private.ID, http.StatusForbidden},
		{nested.ID, http.StatusForbidden}, {file.ID, http.StatusBadRequest},
	} {
		t.Run(tc.parent, func(t *testing.T) {
			s := contractStore(private, nested, file)
			w := contractRequest(s, contractPrincipal(roleMember), http.MethodGet, "/api/v1/resources?scope=files&parentId="+tc.parent, nil)
			if w.Code != tc.status {
				t.Fatalf("want %d, got %d: %s", tc.status, w.Code, w.Body.String())
			}
		})
	}
}

func TestFilesContractBreadcrumbsAndTotal(t *testing.T) {
	s := contractStore(contractItem("top", "folder", ""), contractItem("current", "folder", "top"),
		contractItem("alpha", "file", "current"), contractItem("beta", "folder", "current"))
	page := readContractPage(t, s, contractPrincipal(roleMember), "parentId=current&limit=1")
	if len(page.Ancestors) != 2 || page.Ancestors[0].ID != "top" || page.Ancestors[1].ID != "current" || page.Ancestors[1].Name != "current" {
		t.Errorf("want root-to-current breadcrumbs without virtual root, got %+v", page.Ancestors)
	}
	if page.Total != 2 || len(page.Items) != 1 || page.NextCursor == "" {
		t.Errorf("incorrect page count: %+v", page)
	}
	if !page.CanRead || !page.CanWrite || !page.CanCreateChild {
		t.Errorf("missing effective current-folder capabilities: %+v", page)
	}
	filtered := readContractPage(t, s, contractPrincipal(roleMember), "parentId=current&q=ALPHA")
	if filtered.Total != 1 || len(filtered.Items) != 1 || filtered.Items[0].ID != "alpha" {
		t.Errorf("total must reflect readable search results: %+v", filtered)
	}
}

func TestFilesContractRootAndItemCapabilitiesRespectRole(t *testing.T) {
	for _, role := range []string{roleGuest, roleMember, roleAdmin, roleOwner} {
		t.Run(role, func(t *testing.T) {
			item := contractItem("folder", "folder", "")
			item.OwnerID = "reader" // Even ownership cannot bypass the global write gate.
			s := contractStore(item, contractItem("file", "file", ""))
			page := readContractPage(t, s, contractPrincipal(role), "parentId=")
			wantWrite := role != roleGuest
			if !page.CanRead || page.CanWrite != wantWrite || page.CanCreateChild != wantWrite || len(page.Ancestors) != 0 {
				t.Errorf("wrong root capabilities: %+v", page)
			}
			for _, view := range page.Items {
				if !view.CanRead || view.CanWrite != wantWrite || view.CanCreateChild != (wantWrite && view.Type == "folder") {
					t.Errorf("wrong item capabilities: %+v", view)
				}
			}
		})
	}
}

func TestFilesContractReadableAncestorsAndRecent(t *testing.T) {
	private := contractItem("private", "folder", "")
	private.ACL = protocol.ResourceACL{}
	old := contractItem("old", "file", "visible")
	newer := contractItem("new", "file", "")
	newer.UpdatedAt = "2026-02-01T00:00:00Z"
	secret := contractItem("secret", "file", "")
	secret.ACL = protocol.ResourceACL{}
	s := contractStore(private, contractItem("visible", "folder", ""), old, newer, secret,
		contractItem("hidden", "file", "private"), contractItem("orphan", "file", "missing"))
	for _, query := range []string{"recent=true", "recent=true&sortBy=name&sortOrder=asc"} {
		page := readContractPage(t, s, contractPrincipal(roleMember), query)
		if page.Total != 2 || len(page.Items) != 2 || page.Items[0].ID != "new" || page.Items[1].ID != "old" {
			t.Errorf("recent must contain only readable files, newest first: %+v", page)
		}
	}
	page := readContractPage(t, s, contractPrincipal(roleMember), "parentId=")
	if page.Total != 2 || len(page.Items) != 2 {
		t.Errorf("root leaked unreadable or nested entries: %+v", page)
	}
	for _, id := range []string{"hidden", "orphan"} {
		w := contractRequest(s, contractPrincipal(roleMember), http.MethodGet, "/api/v1/resources/"+id, nil)
		if w.Code != http.StatusForbidden {
			t.Errorf("GET %s bypassed ancestry: %d", id, w.Code)
		}
	}
}

func TestFilesContractSortWholeDirectoryBeforePagination(t *testing.T) {
	folder := contractItem("folder", "folder", "")
	a := contractItem("a", "file", "")
	b := contractItem("b", "file", "")
	c := contractItem("c", "file", "")
	a.Name, b.Name, c.Name = "z", "A", "a"
	a.Meta, b.Meta, c.Meta = map[string]interface{}{"size": float64(2)}, map[string]interface{}{"size": int64(10)}, nil
	a.UpdatedAt, b.UpdatedAt, c.UpdatedAt = "2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"
	for _, tc := range []struct{ sort, order, want string }{
		{"name", "asc", "folder,b,c,a"}, {"name", "desc", "folder,a,b,c"},
		{"size", "asc", "folder,c,a,b"}, {"size", "desc", "folder,b,a,c"},
		{"updatedAt", "asc", "folder,b,a,c"}, {"updatedAt", "desc", "folder,c,a,b"},
	} {
		t.Run(tc.sort+tc.order, func(t *testing.T) {
			s := contractStore(c, a, folder, b)
			query := "parentId=&limit=1&sortBy=" + tc.sort + "&sortOrder=" + tc.order
			ids := []string{}
			cursor := ""
			for i := 0; i < 4; i++ {
				page := readContractPage(t, s, contractPrincipal(roleMember), query+"&cursor="+url.QueryEscape(cursor))
				if len(page.Items) != 1 {
					t.Fatalf("unexpected page: %+v", page)
				}
				if page.Total != 4 {
					t.Errorf("want total 4, got %d", page.Total)
				}
				ids = append(ids, page.Items[0].ID)
				cursor = page.NextCursor
			}
			if strings.Join(ids, ",") != tc.want || cursor != "" {
				t.Errorf("want %s, got %v (cursor %q)", tc.want, ids, cursor)
			}
		})
	}
}

func TestFilesContractCursorBoundToQueryAndRevision(t *testing.T) {
	s := contractStore(contractItem("a", "folder", ""), contractItem("b", "folder", ""), contractItem("child", "file", "a"))
	principal := contractPrincipal(roleMember)
	base := "parentId=&sortBy=name&sortOrder=asc&limit=1"
	first := readContractPage(t, s, principal, base)
	if _, err := base64.RawURLEncoding.DecodeString(first.NextCursor); err != nil {
		t.Errorf("cursor must be opaque base64url, got %q", first.NextCursor)
	}
	for _, query := range []string{
		"parentId=a&sortBy=name&sortOrder=asc", "sortBy=name&sortOrder=asc",
		"parentId=&recent=true&sortBy=name&sortOrder=asc", "parentId=&q=a&sortBy=name&sortOrder=asc",
		"parentId=&sortBy=size&sortOrder=asc", "parentId=&sortBy=name&sortOrder=desc",
	} {
		w := contractRequest(s, principal, http.MethodGet, "/api/v1/resources?scope=files&"+query+"&cursor="+url.QueryEscape(first.NextCursor), nil)
		if w.Code != http.StatusBadRequest {
			t.Errorf("cross-query cursor accepted for %s: %d %s", query, w.Code, w.Body.String())
		}
	}
	// Page size can change without changing the result set.
	second := readContractPage(t, s, principal, "parentId=&sortBy=name&sortOrder=asc&limit=2&cursor="+url.QueryEscape(first.NextCursor))
	if len(second.Items) != 1 || second.Items[0].ID != "b" {
		t.Errorf("valid continuation failed: %+v", second)
	}
	w := contractRequest(s, principal, http.MethodPatch, "/api/v1/resources/b", map[string]string{"name": "renamed"})
	if w.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", w.Code, w.Body.String())
	}
	w = contractRequest(s, principal, http.MethodGet, "/api/v1/resources?scope=files&"+base+"&cursor="+url.QueryEscape(first.NextCursor), nil)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "CURSOR_STALE") {
		t.Errorf("want CURSOR_STALE after mutation, got %d %s", w.Code, w.Body.String())
	}
}

func TestFilesContractRejectsMalformedCursors(t *testing.T) {
	for _, cursor := range []string{"garbage", "0:-1", "0:1:2", "0:999999999999999999999999", base64.RawURLEncoding.EncodeToString([]byte(`{}`)), base64.RawURLEncoding.EncodeToString([]byte(`{"offset":-1}`))} {
		t.Run(cursor, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Errorf("cursor panicked: %v", recovered)
				}
			}()
			w := contractRequest(contractStore(contractItem("a", "folder", "")), contractPrincipal(roleMember), http.MethodGet,
				"/api/v1/resources?scope=files&parentId=&cursor="+url.QueryEscape(cursor), nil)
			if w.Code != http.StatusBadRequest {
				t.Errorf("want 400, got %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestFilesContractCursorRejectsInvalidPayloads(t *testing.T) {
	s := contractStore(contractItem("a", "folder", ""), contractItem("b", "folder", ""))
	principal := contractPrincipal(roleMember)
	page := readContractPage(t, s, principal, "parentId=&limit=1")
	raw, err := base64.RawURLEncoding.DecodeString(page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		field string
		value interface{}
	}{
		{"offset", -1}, {"offset", 1 << 30}, {"offset", nil}, {"offset", "1"},
		{"offset", 1.5}, {"revision", -1}, {"revision", nil}, {"version", 0}, {"query", "other"},
	} {
		t.Run(fmt.Sprintf("%s=%v", tc.field, tc.value), func(t *testing.T) {
			var payload map[string]interface{}
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			payload[tc.field] = tc.value
			encoded, _ := json.Marshal(payload)
			cursor := base64.RawURLEncoding.EncodeToString(encoded)
			w := contractRequest(s, principal, http.MethodGet, "/api/v1/resources?scope=files&parentId=&cursor="+url.QueryEscape(cursor), nil)
			if w.Code != http.StatusBadRequest {
				t.Errorf("malformed payload accepted: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestFilesContractSpecialOwnersRequireGrants(t *testing.T) {
	for _, ownerID := range []string{"", "system"} {
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
			for _, tc := range []struct {
				name, restricted, method, path string
				hidden                         bool
				body                           map[string]string
				status                         int
			}{
				{"read-ancestor", "top", http.MethodGet, "/api/v1/resources/item", true, nil, http.StatusOK},
				{"list-ancestor", "top", http.MethodGet, "/api/v1/resources?scope=files&parentId=parent", true, nil, http.StatusOK},
				{"rename-item", "item", http.MethodPatch, "/api/v1/resources/item", false, map[string]string{"name": "renamed"}, http.StatusOK},
				{"rename-source", "parent", http.MethodPatch, "/api/v1/resources/item", false, map[string]string{"name": "renamed"}, http.StatusOK},
				{"delete-source", "parent", http.MethodDelete, "/api/v1/resources/item?recursive=true", false, nil, http.StatusOK},
				{"create-target", "target", http.MethodPost, "/api/v1/resources", false, map[string]string{"name": "created", "parentId": "target"}, http.StatusCreated},
				{"move-target", "target", http.MethodPatch, "/api/v1/resources/item", false, map[string]string{"parentId": "target"}, http.StatusOK},
				{"move-subtree", "leaf", http.MethodPatch, "/api/v1/resources/item", false, map[string]string{"parentId": "target"}, http.StatusOK},
				{"delete-subtree", "leaf", http.MethodDelete, "/api/v1/resources/item?recursive=true", false, nil, http.StatusOK},
				{"share-item", "item", http.MethodPost, "/api/v1/resources/item/share", false, nil, http.StatusCreated},
				{"share-source", "parent", http.MethodPost, "/api/v1/resources/item/share", false, nil, http.StatusCreated},
			} {
				t.Run(fmt.Sprintf("owner=%q/%s/%s", ownerID, access.name, tc.name), func(t *testing.T) {
					s := contractStore(contractItem("top", "folder", ""), contractItem("parent", "folder", "top"),
						contractItem("item", "folder", "parent"), contractItem("leaf", "file", "item"), contractItem("target", "folder", ""))
					restricted := s.state.Resources[tc.restricted]
					restricted.OwnerID = ownerID
					restricted.ACL = protocol.ResourceACL{}
					if !tc.hidden {
						restricted.ACL.Grants = []protocol.ResourceGrant{{Subject: "*", Actions: []string{"resource.read"}}}
					}
					if access.grant {
						restricted.ACL.Grants = append(restricted.ACL.Grants, protocol.ResourceGrant{Subject: roleMember, Actions: []string{"resource.read", "resource.write"}})
					}
					s.state.Resources[restricted.ID] = restricted
					s.hub = newHub()
					before := resourceStateJSON(t, s)
					p := contractPrincipal(access.role)
					var w *httptest.ResponseRecorder
					if strings.HasSuffix(tc.path, "/share") {
						w = httptest.NewRecorder()
						s.handleResourceShare(w, httptest.NewRequest(tc.method, tc.path, nil), "item", p)
					} else {
						w = contractRequest(s, p, tc.method, tc.path, tc.body)
					}
					want := http.StatusForbidden
					if access.allowed {
						want = tc.status
					}
					if w.Code != want {
						t.Errorf("want %d, got %d: %s", want, w.Code, w.Body.String())
					}
					if !access.allowed {
						if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
							t.Error("denied request changed state/revision")
						}
						assertResourceEvents(t, s, 0)
						if tc.hidden {
							for _, query := range []string{"parentId=", "recent=true", "q=leaf"} {
								page := readContractPage(t, s, p, query)
								for _, item := range page.Items {
									if item.ID != "target" {
										t.Errorf("listing leaked restricted ancestor or descendant: %s", item.ID)
									}
								}
							}
						}
					}
				})
			}
		}
	}
}

func TestFilesContractMutationAuthorization(t *testing.T) {
	for _, mode := range []string{"hidden-ancestor", "read-only-parent", "read-only-item"} {
		for _, method := range []string{http.MethodPatch, http.MethodDelete} {
			t.Run(mode+method, func(t *testing.T) {
				top := contractItem("top", "folder", "")
				parent := contractItem("parent", "folder", "top")
				item := contractItem("item", "folder", "parent")
				switch mode {
				case "hidden-ancestor":
					top.ACL = protocol.ResourceACL{}
				case "read-only-parent":
					parent.ACL.Grants[0].Actions = []string{"resource.read"}
				case "read-only-item":
					item.ACL.Grants[0].Actions = []string{"resource.read"}
				}
				s := contractStore(top, parent, item)
				before, _ := json.Marshal(s.state.Resources)
				w := contractRequest(s, contractPrincipal(roleMember), method, "/api/v1/resources/item", map[string]string{"name": "changed", "parentId": ""})
				if w.Code != http.StatusForbidden {
					t.Errorf("want 403, got %d %s", w.Code, w.Body.String())
				}
				after, _ := json.Marshal(s.state.Resources)
				if !bytes.Equal(before, after) || s.resourceRev != 0 {
					t.Error("denied mutation changed state")
				}
			})
		}
	}
}

func TestFilesContractCreateAndMoveRequireWritableDestination(t *testing.T) {
	for _, mode := range []string{"read-only", "hidden", "hidden-ancestor"} {
		for _, method := range []string{http.MethodPost, http.MethodPatch} {
			t.Run(mode+method, func(t *testing.T) {
				top := contractItem("top", "folder", "")
				target := contractItem("target", "folder", "top")
				switch mode {
				case "read-only":
					target.ACL.Grants[0].Actions = []string{"resource.read"}
				case "hidden":
					target.ACL.Grants[0].Actions = []string{"resource.write"}
				case "hidden-ancestor":
					top.ACL = protocol.ResourceACL{}
				}
				s := contractStore(top, target, contractItem("source", "folder", ""))
				path := "/api/v1/resources"
				if method == http.MethodPatch {
					path += "/source"
				}
				before, _ := json.Marshal(s.state.Resources)
				w := contractRequest(s, contractPrincipal(roleMember), method, path, map[string]string{"name": "new", "parentId": "target"})
				if w.Code != http.StatusForbidden {
					t.Errorf("want 403, got %d %s", w.Code, w.Body.String())
				}
				after, _ := json.Marshal(s.state.Resources)
				if !bytes.Equal(before, after) || s.resourceRev != 0 {
					t.Error("denied mutation changed state")
				}
			})
		}
	}
}

func TestFilesContractCapabilitiesMatchSourceParentAndCreation(t *testing.T) {
	parent := contractItem("parent", "folder", "")
	parent.ACL.Grants[0].Actions = []string{"resource.read"}
	s := contractStore(parent, contractItem("child", "folder", "parent"))
	principal := contractPrincipal(roleMember)
	page := readContractPage(t, s, principal, "parentId=parent")
	if page.CanWrite || page.CanCreateChild || len(page.Items) != 1 {
		t.Fatalf("wrong read-only parent capabilities: %+v", page)
	}
	view := page.Items[0]
	if !view.CanRead || view.CanWrite || !view.CanCreateChild {
		t.Errorf("child rename needs source parent write; child creation does not: %+v", view)
	}
	current := readContractPage(t, s, principal, "parentId=child")
	if current.CanWrite || !current.CanCreateChild {
		t.Errorf("current capabilities differ from item: %+v", current)
	}
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		w := contractRequest(s, principal, method, "/api/v1/resources/child", map[string]string{"name": "renamed"})
		if w.Code != http.StatusForbidden {
			t.Errorf("%s must respect source parent: %d", method, w.Code)
		}
	}
	w := contractRequest(s, principal, http.MethodPost, "/api/v1/resources", map[string]string{"name": "grandchild", "parentId": "child"})
	if w.Code != http.StatusCreated {
		t.Errorf("writable child should allow creation: %d %s", w.Code, w.Body.String())
	}
}

func TestResourceShareRequiresGlobalWrite(t *testing.T) {
	for _, id := range []string{"project_gateway", "file"} {
		for _, role := range []string{roleGuest, roleMember, roleAdmin, roleOwner} {
			t.Run(id+"/"+role, func(t *testing.T) {
				s := newMVPStore(memoryBackend{}, nil)
				s.hub = newHub()
				s.state.Resources["file"] = contractItem("file", "file", "")
				project := s.state.Resources["project_gateway"]
				if project.Type != "code.project" || project.OwnerID != "system" {
					t.Fatal("expected seeded system-owned project")
				}
				s.state.Shares["existing"] = protocol.ResourceShareLink{Token: "existing", ResourceID: id}
				before := resourceStateJSON(t, s)
				w := httptest.NewRecorder()
				s.handleResourceShare(w, httptest.NewRequest(http.MethodPost, "/api/v1/resources/"+id+"/share", nil), id, contractPrincipal(role))
				want := http.StatusCreated
				if role == roleGuest {
					want = http.StatusForbidden
				}
				if w.Code != want {
					t.Errorf("want %d, got %d: %s", want, w.Code, w.Body.String())
				}
				if role == roleGuest {
					if !bytes.Equal(before, resourceStateJSON(t, s)) || s.resourceRev != 0 {
						t.Error("denied share changed shares/state/revision")
					}
					assertResourceEvents(t, s, 0)
				} else if len(s.state.Shares) != 2 {
					t.Error("authorized share was not created")
				}
			})
		}
	}
}

func TestFilesContractShareRespectsEffectiveWrite(t *testing.T) {
	for _, tc := range []struct {
		name, role   string
		hiddenParent bool
		status       int
	}{
		{"guest-with-write-grant", roleGuest, false, http.StatusForbidden},
		{"hidden-ancestor", roleMember, true, http.StatusForbidden},
		{"writable-member", roleMember, false, http.StatusCreated},
		{"admin", roleAdmin, true, http.StatusCreated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := contractItem("parent", "folder", "")
			if tc.hiddenParent {
				parent.ACL = protocol.ResourceACL{}
			}
			s := contractStore(parent, contractItem("file", "file", "parent"))
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/api/v1/resources/file/share", strings.NewReader(`{}`))
			s.handleResourceShare(w, r, "file", contractPrincipal(tc.role))
			if w.Code != tc.status {
				t.Errorf("want %d, got %d %s", tc.status, w.Code, w.Body.String())
			}
			if tc.status == http.StatusForbidden && len(s.state.Shares) != 0 {
				t.Error("denied share must not be persisted")
			}
		})
	}
}

func TestFilesContractRecursiveDeletePreflightsAllDescendants(t *testing.T) {
	root := contractItem("root", "folder", "")
	child := contractItem("child", "folder", "root")
	private := contractItem("private", "file", "child")
	private.ACL.Grants[0].Actions = []string{"resource.read"}
	s := contractStore(root, child, private)
	before, _ := json.Marshal(s.state.Resources)
	w := contractRequest(s, contractPrincipal(roleMember), http.MethodDelete, "/api/v1/resources/root?recursive=true", nil)
	if w.Code != http.StatusForbidden {
		t.Errorf("want 403, got %d %s", w.Code, w.Body.String())
	}
	after, _ := json.Marshal(s.state.Resources)
	if !bytes.Equal(before, after) || s.resourceRev != 0 {
		t.Error("recursive denial must be atomic")
	}
}

func TestFilesContractFilesRequireUploadPipeline(t *testing.T) {
	for _, meta := range []interface{}{nil, map[string]interface{}{"contentHash": strings.Repeat("a", 64), "size": 12, "mimeType": "text/plain", "uploadId": "forged"}} {
		s := contractStore()
		w := contractRequest(s, contractPrincipal(roleMember), http.MethodPost, "/api/v1/resources", map[string]interface{}{"type": "file", "name": "forged.txt", "meta": meta})
		if w.Code != http.StatusBadRequest || len(s.state.Resources) != 0 || s.resourceRev != 0 {
			t.Errorf("general POST must reject file creation: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestFilesContractNamesRejectControlsBeforeTrimming(t *testing.T) {
	for _, name := range []string{"\tname", "name\n", "\rname", "a\x7fb", "name\u0085", "a\x00b"} {
		for _, method := range []string{http.MethodPost, http.MethodPatch} {
			t.Run(fmt.Sprintf("%s/%q", method, name), func(t *testing.T) {
				s := contractStore(contractItem("item", "folder", ""))
				path := "/api/v1/resources"
				if method == http.MethodPatch {
					path += "/item"
				}
				w := contractRequest(s, contractPrincipal(roleMember), method, path, map[string]string{"name": name})
				if w.Code != http.StatusBadRequest {
					t.Errorf("control in name accepted: %d %s", w.Code, w.Body.String())
				}
			})
		}
	}
}

func TestFilesContractPatchCannotForgeOwnershipOrContent(t *testing.T) {
	item := contractItem("file", "file", "")
	item.ACL.OwnerID = item.OwnerID
	item.Meta = map[string]interface{}{"contentHash": strings.Repeat("a", 64), "size": float64(5), "mimeType": "text/plain", "uploadId": "real"}
	s := contractStore(item)
	w := contractRequest(s, contractPrincipal(roleMember), http.MethodPatch, "/api/v1/resources/file", map[string]interface{}{
		"ownerId": "reader", "type": "folder", "contentHash": "forged",
		"acl":  map[string]interface{}{"ownerId": "reader", "grants": item.ACL.Grants},
		"meta": map[string]interface{}{"contentHash": "forged", "size": 999, "mimeType": "fake", "uploadId": "fake", "label": "safe"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("safe metadata update: %d %s", w.Code, w.Body.String())
	}
	got := s.state.Resources["file"]
	if got.OwnerID != item.OwnerID || got.ACL.OwnerID != item.ACL.OwnerID || got.Type != "file" {
		t.Errorf("ownership/type forged: %+v", got)
	}
	if got.Meta["contentHash"] != strings.Repeat("a", 64) || got.Meta["size"] != float64(5) || got.Meta["mimeType"] != "text/plain" || got.Meta["uploadId"] != "real" || got.Meta["label"] != "safe" {
		t.Errorf("content metadata changed or safe metadata lost: %+v", got.Meta)
	}
}
