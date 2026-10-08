package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func desktopFixture(t *testing.T) (*mvpStore, func(string, string, string, interface{}) *httptest.ResponseRecorder) {
	t.Helper()
	auth := newAuthStore("demo", "pass", newAccessPolicy(), newAccessStore())
	for _, id := range []string{"alice", "bob", "eve"} {
		auth.sessions[id] = authPrincipal{Token: id, UserID: id, DisplayName: id, Role: roleMember, WorkspaceID: "demo", Status: accessStatusActive, ExpiresAt: time.Now().Add(time.Hour)}
	}
	s := newMVPStore(memoryBackend{}, newHub())
	registerMVPAuth(s, auth)
	mux := http.NewServeMux()
	registerMVPRoutes(mux, auth, s)
	return s, func(user, method, path string, body interface{}) *httptest.ResponseRecorder {
		var raw bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&raw).Encode(body)
		}
		req := httptest.NewRequest(method, path, &raw)
		req.Header.Set("Authorization", "Bearer "+user)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w
	}
}

func TestDesktopPersonalLocationsAndAtomicOperations(t *testing.T) {
	s, req := desktopFixture(t)
	var prefs filePreferences
	w := req("alice", "GET", "/api/v1/file-preferences", nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &prefs)
	if prefs.DownloadsID == "" || prefs.ReceiveFolderID != prefs.DownloadsID {
		t.Fatalf("missing default Downloads: %+v", prefs)
	}
	w = req("alice", "GET", "/api/v1/resources?scope=files&parentId="+prefs.DownloadsID, nil)
	var listing struct {
		CanWrite       bool `json:"canWrite"`
		CanCreateChild bool `json:"canCreateChild"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &listing)
	if !listing.CanWrite || !listing.CanCreateChild {
		t.Fatal("protected Downloads must still allow editing its contents")
	}
	if w = req("bob", "GET", "/api/v1/resources/"+prefs.DownloadsID, nil); w.Code != 403 {
		t.Fatalf("private Downloads leaked: %d", w.Code)
	}
	if w = req("alice", "PATCH", "/api/v1/resources/"+prefs.DownloadsID, map[string]string{"name": "changed"}); w.Code != 403 {
		t.Fatal("system folder renamed")
	}
	item := contractItem("folder", "folder", "")
	item.OwnerID = "alice"
	s.state.Resources[item.ID] = item
	child := contractItem("child", "file", item.ID)
	child.OwnerID = "alice"
	child.Meta = map[string]interface{}{"contentHash": strings.Repeat("a", 64)}
	s.state.Resources[child.ID] = child
	op := func(action string, ids []string, parent string) *httptest.ResponseRecorder {
		return req("alice", "POST", "/api/v1/file-operations", map[string]interface{}{"action": action, "ids": ids, "parentId": parent})
	}
	if w = op("copy", []string{item.ID}, prefs.DownloadsID); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if s.state.Resources["child"].ParentID != "folder" {
		t.Fatal("copy mutated source")
	}
	if w = op("move", []string{item.ID}, child.ID); w.Code != 400 {
		t.Fatalf("self descendant accepted: %d", w.Code)
	}
	if w = op("trash", []string{item.ID, child.ID}, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if s.state.Resources[item.ID].ParentID != prefs.TrashID || s.state.Resources[child.ID].ParentID != item.ID {
		t.Fatal("trash lost hierarchy")
	}
	if w = op("restore", []string{item.ID}, ""); w.Code != 200 || s.state.Resources[item.ID].ParentID != "" {
		t.Fatalf("restore failed: %s", w.Body.String())
	}
	before := resourceStateJSON(t, s)
	if w = op("move", []string{item.ID, "missing"}, prefs.DownloadsID); w.Code != 404 || !bytes.Equal(before, resourceStateJSON(t, s)) {
		t.Fatal("batch must be atomic")
	}
}

func TestDesktopChatFilesArePrivateDurableAndIdempotent(t *testing.T) {
	s, req := desktopFixture(t)
	s.state.Channels["private"] = protocol.ChatChannel{ID: "private", WorkspaceID: "demo", Kind: "direct", MemberIDs: []string{"alice", "bob"}}
	item := contractItem("attachment", "file", "")
	item.OwnerID = "alice"
	item.ACL = protocol.ResourceACL{OwnerID: "alice"}
	item.Name = "report.txt"
	item.Meta = map[string]interface{}{"contentHash": strings.Repeat("a", 64), "size": 12, "mimeType": "text/plain"}
	s.state.Resources[item.ID] = item
	input := map[string]interface{}{"channelId": "private", "clientMsgId": "same-retry-id", "blocks": []protocol.MessageBlock{{Type: "file.reference", Value: map[string]interface{}{"resourceId": item.ID, "contentHash": strings.Repeat("b", 64)}}}}
	w := req("alice", "POST", "/api/v1/messages", input)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var accepted protocol.AcceptedMessage
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	message := s.state.Messages[accepted.MessageID]
	if message.Blocks[0].Value["contentHash"] != strings.Repeat("a", 64) {
		t.Fatal("trusted forged attachment hash")
	}
	pref := s.state.FilePreferences["bob"]
	if pref.DownloadsID == "" {
		t.Fatal("receiver default folder not created")
	}
	ids := s.state.MessageReceipts["bob:"+message.ID]
	if len(ids) != 1 || s.state.Resources[ids[0]].ParentID != pref.DownloadsID {
		t.Fatal("not delivered to Downloads")
	}
	if _, exists := s.state.FilePreferences["eve"]; exists {
		t.Fatal("delivered private message to nonmember")
	}
	count := len(s.state.Resources)
	if w = req("alice", "POST", "/api/v1/messages", input); w.Code != 200 || len(s.state.Resources) != count {
		t.Fatal("retry duplicated receipt")
	}
	if w = req("bob", "POST", "/api/v1/chat-receipts/"+message.ID, nil); w.Code != 200 || len(s.state.Resources) != count {
		t.Fatal("receipt is not idempotent")
	}
	if w = req("eve", "POST", "/api/v1/chat-receipts/"+message.ID, nil); w.Code != 403 {
		t.Fatal("receipt membership bypass")
	}
	if w = req("eve", "GET", "/api/v1/messages", nil); strings.Contains(w.Body.String(), message.ID) {
		t.Fatal("global search leaked private message")
	}
	if w = req("alice", "PATCH", "/api/v1/messages/"+message.ID, map[string]interface{}{"body": "edited", "blocks": []protocol.MessageBlock{{Type: "file.reference", Value: map[string]interface{}{"contentHash": "forged"}}}}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if s.state.Messages[message.ID].Blocks[0].Value["contentHash"] != strings.Repeat("a", 64) {
		t.Fatal("edit altered attachment snapshot")
	}
	// Receipts remain usable when sender removes the source entry.
	delete(s.state.Resources, item.ID)
	if w = req("bob", "GET", "/api/v1/resources/"+ids[0], nil); w.Code != 200 {
		t.Fatal("source deletion broke received entry")
	}
	for _, event := range s.hub.store.Retained() {
		raw, _ := json.Marshal(event.Payload)
		if bytes.Contains(raw, []byte("report.txt")) || bytes.Contains(raw, []byte("edited")) {
			t.Fatal("broadcast leaked private content")
		}
	}
}

func TestDesktopCustomDestinationAndFailureRollback(t *testing.T) {
	s, req := desktopFixture(t)
	folder := contractItem("custom", "folder", "")
	folder.OwnerID = "bob"
	s.state.Resources[folder.ID] = folder
	w := req("bob", "PATCH", "/api/v1/file-preferences", map[string]string{"receiveFolderId": "custom"})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	item := contractItem("file", "file", "")
	item.OwnerID = "alice"
	item.Meta = map[string]interface{}{"contentHash": strings.Repeat("c", 64), "size": 1}
	s.state.Resources[item.ID] = item
	input := map[string]interface{}{"body": "file", "channelId": "engineering", "clientMsgId": "custom", "blocks": []protocol.MessageBlock{{Type: "file.reference", Value: map[string]interface{}{"resourceId": "file"}}}}
	w = req("alice", "POST", "/api/v1/messages", input)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var accepted protocol.AcceptedMessage
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	ids := s.state.MessageReceipts["bob:"+accepted.MessageID]
	if len(ids) != 1 || s.state.Resources[ids[0]].ParentID != "custom" {
		t.Fatal("custom destination ignored")
	}
	delete(s.state.Resources, "custom")
	input["clientMsgId"] = "fallback"
	w = req("alice", "POST", "/api/v1/messages", input)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &accepted)
	ids = s.state.MessageReceipts["bob:"+accepted.MessageID]
	if s.state.Resources[ids[0]].ParentID != s.state.FilePreferences["bob"].DownloadsID {
		t.Fatal("removed destination did not fall back")
	}
	backend := &resourceTransactionBackend{sqliteBackend: newTestSQLiteBackend(t, "")}
	s.backend = backend
	before := resourceStateJSON(t, s)
	_ = backend.saveMVPState(before)
	backend.failBlob = true
	if w = req("bob", "POST", "/api/v1/chat-receipts/"+accepted.MessageID, nil); w.Code != 200 {
		t.Fatal("reading an existing receipt attempted another persistent write")
	}
	input["clientMsgId"] = "failure"
	events := len(s.hub.store.Retained())
	w = req("alice", "POST", "/api/v1/messages", input)
	if w.Code != 500 || !bytes.Equal(before, resourceStateJSON(t, s)) || len(s.hub.store.Retained()) != events {
		t.Fatal("failed message save published partial state")
	}
	backend.failBlob = false
	restored := newMVPStore(backend, newHub())
	if len(restored.state.MessageReceipts) != len(s.state.MessageReceipts) || restored.state.FilePreferences["bob"].ReceiveFolderID != "custom" {
		t.Fatal("preferences/receipts did not persist")
	}
}

func TestDesktopMessageNewestPageAndAttachmentValidation(t *testing.T) {
	s, req := desktopFixture(t)
	for i := 0; i < 210; i++ {
		id := strings.Repeat("x", i+1)
		s.state.Messages[id] = protocol.ChatMessage{ID: id, ChannelID: "engineering", CreatedAt: time.Unix(int64(i), 0).UTC().Format(time.RFC3339)}
	}
	page, next := s.listMessagePage("engineering", "", "", "", "", "", 100, "", true)
	if len(page) != 100 || next != "100" || page[0].ID != strings.Repeat("x", 210) {
		t.Fatal("newest page is incorrect")
	}
	w := req("alice", "POST", "/api/v1/messages", map[string]interface{}{"channelId": "engineering", "blocks": []protocol.MessageBlock{{Type: "file.reference", Value: map[string]interface{}{"resourceId": "unknown"}}}})
	if w.Code != 400 {
		t.Fatal("unreadable attachment accepted")
	}
	w = req("alice", "POST", "/api/v1/messages", map[string]interface{}{"channelId": "engineering", "blocks": []protocol.MessageBlock{{Type: "code.snippet", Value: map[string]interface{}{"language": "go", "content": "fmt.Println(42)"}}}})
	if w.Code != 201 {
		t.Fatalf("code-only message rejected: %s", w.Body.String())
	}
}
