package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func auditOf(t *testing.T, store *auditStore, action string) []auditEntryView {
	t.Helper()
	var matched []auditEntryView
	for _, entry := range store.list() {
		if entry.Action == action {
			matched = append(matched, entry)
		}
	}
	return matched
}

func TestAuditStoreRecordsNewestFirstAndBounds(t *testing.T) {
	store := newAuditStore()
	for i := 0; i < auditCapacity+5; i++ {
		store.record(auditEntry{Action: "session.issue", Detail: string(rune('a' + i%26))})
	}
	entries := store.list()
	if len(entries) != auditCapacity {
		t.Fatalf("expected audit store bounded to %d entries, got %d", auditCapacity, len(entries))
	}
	if entries[0].ID == "" || entries[0].At == "" {
		t.Fatalf("expected audit view to carry id and RFC3339 time, got %#v", entries[0])
	}
	first := entries[len(entries)-1]
	last := entries[0]
	if first.ID != "aud_6" || last.ID == first.ID {
		t.Fatalf("expected oldest retained entry to be aud_6, got first=%#v last=%#v", first, last)
	}
}

func TestSessionIssueWritesAuditEntries(t *testing.T) {
	auth, hub := newTestGateway()
	audit := newAuditStore()
	limiter := newRateLimiter(1000, 1000)
	handler := handleSessionIssue(auth, hub, audit, limiter)

	post := func(body map[string]interface{}, remoteAddr string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = remoteAddr
		recorder := httptest.NewRecorder()
		handler(recorder, request)
		return recorder
	}

	if recorder := post(map[string]interface{}{"workspaceId": "demo", "accessType": "guest"}, "192.0.2.1:1000"); recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 while guest policy off, got %d", recorder.Code)
	}
	denied := auditOf(t, audit, auditActionSessionDenied)
	if len(denied) != 1 || denied[0].Detail != "guest" || denied[0].RemoteAddr == "" {
		t.Fatalf("expected one session.denied audit entry for guest, got %#v", denied)
	}

	if recorder := post(map[string]interface{}{"workspaceId": "demo", "displayName": "审计成员", "accessType": "login"}, "192.0.2.2:1000"); recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201 for login, got %d body=%s", recorder.Code, recorder.Body.String())
	}
	issued := auditOf(t, audit, auditActionSessionIssue)
	if len(issued) != 1 {
		t.Fatalf("expected one session.issue audit entry, got %#v", issued)
	}
	if issued[0].ActorName != "审计成员" || issued[0].ActorUserID == "" || issued[0].Detail != "login" || issued[0].Target == "" {
		t.Fatalf("unexpected session.issue audit entry: %#v", issued[0])
	}
}

func TestPolicyUpdateWritesAuditEntry(t *testing.T) {
	auth, hub := newTestGateway()
	audit := newAuditStore()
	admin := issueAuditAdmin(t, auth)

	limiter := newRateLimiter(1000, 1000)
	mux := http.NewServeMux()
	registerAccessRoutes(mux, auth, hub, audit, limiter)

	patchRaw := []byte(`{"allowAnonymousApplication": true}`)
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/access-policy", bytes.NewReader(patchRaw))
	request.Header.Set("Authorization", "Bearer "+admin.Token)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin patch, got %d body=%s", recorder.Code, recorder.Body.String())
	}

	entries := auditOf(t, audit, auditActionPolicyUpdate)
	if len(entries) != 1 {
		t.Fatalf("expected one access.policy.update audit entry, got %#v", entries)
	}
	if entries[0].ActorUserID != admin.UserID || entries[0].Detail == "" {
		t.Fatalf("unexpected policy audit entry: %#v", entries[0])
	}
}

func TestRecordReviewWritesAuditEntries(t *testing.T) {
	auth, hub := newTestGateway()
	audit := newAuditStore()
	auth.policy.set(true, false)
	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "申请者甲", AccessType: "anonymous"}); errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}
	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "申请者乙", AccessType: "anonymous"}); errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}
	admin := issueAuditAdmin(t, auth)

	limiter := newRateLimiter(1000, 1000)
	mux := http.NewServeMux()
	registerAccessRoutes(mux, auth, hub, audit, limiter)

	var pendingIDs []string
	for _, record := range auth.records.list() {
		if record.AccessType == "anonymous" && record.Status == "pending" {
			pendingIDs = append(pendingIDs, record.ID)
		}
	}
	if len(pendingIDs) != 2 {
		t.Fatalf("expected two pending records, got %#v", pendingIDs)
	}

	call := func(id, action string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/access-records/"+id+"/"+action, nil)
		request.Header.Set("Authorization", "Bearer "+admin.Token)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	if recorder := call(pendingIDs[0], "approve"); recorder.Code != http.StatusOK {
		t.Fatalf("expected approve 200, got %d", recorder.Code)
	}
	if recorder := call(pendingIDs[1], "reject"); recorder.Code != http.StatusOK {
		t.Fatalf("expected reject 200, got %d", recorder.Code)
	}

	approved := auditOf(t, audit, auditActionRecordApprove)
	rejected := auditOf(t, audit, auditActionRecordReject)
	if len(approved) != 1 || approved[0].Target != pendingIDs[0] || approved[0].ActorUserID != admin.UserID {
		t.Fatalf("unexpected approve audit entries: %#v", approved)
	}
	if len(rejected) != 1 || rejected[0].Target != pendingIDs[1] || rejected[0].ActorUserID != admin.UserID {
		t.Fatalf("unexpected reject audit entries: %#v", rejected)
	}
}

func TestAuditLogEndpointRequiresAdmin(t *testing.T) {
	auth, hub := newTestGateway()
	audit := newAuditStore()
	audit.record(auditEntry{Action: auditActionSessionIssue, ActorName: "某人", Detail: "login"})

	limiter := newRateLimiter(1000, 1000)
	mux := http.NewServeMux()
	registerAccessRoutes(mux, auth, hub, audit, limiter)

	anonymous := httptest.NewRecorder()
	mux.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log", nil))
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", anonymous.Code)
	}

	member := issueLogin(t, auth, "成员")
	memberRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log", nil)
	memberRequest.Header.Set("Authorization", "Bearer "+member.Token)
	memberRecorder := httptest.NewRecorder()
	mux.ServeHTTP(memberRecorder, memberRequest)
	if memberRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for member, got %d", memberRecorder.Code)
	}

	admin := issueAuditAdmin(t, auth)
	adminRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log", nil)
	adminRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	adminRecorder := httptest.NewRecorder()
	mux.ServeHTTP(adminRecorder, adminRequest)
	if adminRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin, got %d", adminRecorder.Code)
	}
	body := recordedBody(t, adminRecorder)
	items, _ := body["items"].([]interface{})
	if len(items) != 1 {
		t.Fatalf("expected one audit entry, got %#v", body)
	}
}

func issueAuditAdmin(t *testing.T, auth *authStore) authPrincipal {
	t.Helper()
	admin, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "审计管理员", AccessType: "login", Passcode: "test-passcode"})
	if errCode != "" {
		t.Fatalf("issue admin session: %s", errCode)
	}
	return admin
}
