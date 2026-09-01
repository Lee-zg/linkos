package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestGateway() (*authStore, *hub) {
	policy := newAccessPolicy()
	records := newAccessStore()
	auth := newAuthStore("demo", "test-passcode", policy, records)
	h := newHub()
	return auth, h
}

func okHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func recordedBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body %q: %v", recorder.Body.String(), err)
	}
	return body
}

func TestLoginPasscodeControlsRole(t *testing.T) {
	auth, _ := newTestGateway()

	member, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "普通成员", AccessType: "login"})
	if errCode != "" || member.Role != "member" {
		t.Fatalf("expected member role without passcode, got %#v err=%s", member, errCode)
	}

	admin, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "管理员", AccessType: "login", Passcode: "test-passcode"})
	if errCode != "" || admin.Role != "admin" {
		t.Fatalf("expected admin role with passcode, got %#v err=%s", admin, errCode)
	}

	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "口令错误", AccessType: "login", Passcode: "wrong"}); errCode != "INVALID_REQUEST" {
		t.Fatalf("expected wrong passcode to be rejected, got %q", errCode)
	}

	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "", AccessType: "login"}); errCode != "INVALID_REQUEST" {
		t.Fatalf("expected empty login display name to be rejected, got %q", errCode)
	}
}

func TestAnonymousApplicationRequiresPolicyAndStaysPending(t *testing.T) {
	auth, _ := newTestGateway()

	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "访客甲", AccessType: "anonymous"}); errCode != "ACCESS_DENIED" {
		t.Fatalf("expected anonymous application denied while policy off, got %q", errCode)
	}

	auth.policy.set(true, false)
	principal, record, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "访客甲", AccessType: "anonymous", Note: "想参与讨论"})
	if errCode != "" {
		t.Fatalf("expected anonymous application accepted while policy on, got %q", errCode)
	}
	if principal.Status != "pending" || record.Status != "pending" || record.AccessType != "anonymous" || record.Note != "想参与讨论" {
		t.Fatalf("unexpected pending principal/record: %#v %#v", principal, record)
	}

	handler := requireActive(auth, "demo", okHandler)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for pending session, got %d", recorder.Code)
	}
	if body := recordedBody(t, recorder); body["error"] != "ACCESS_PENDING" {
		t.Fatalf("expected ACCESS_PENDING error, got %#v", body)
	}
}

func TestApprovingApplicationActivatesSession(t *testing.T) {
	auth, _ := newTestGateway()
	auth.policy.set(true, false)
	principal, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "待审批", AccessType: "anonymous"})
	if errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}

	records := auth.records.list()
	if len(records) != 1 {
		t.Fatalf("expected one record, got %d", len(records))
	}
	reviewed, ok := auth.records.review(records[0].ID, "active", "admin-user")
	if !ok || reviewed.Status != "active" || reviewed.ReviewedBy != "admin-user" || reviewed.ReviewedAt == "" {
		t.Fatalf("unexpected review result: %#v ok=%v", reviewed, ok)
	}
	auth.setUserStatus(reviewed.UserID, reviewed.Status)

	handler := requireActive(auth, "demo", okHandler)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected approved session to pass, got %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRejectingApplicationBlocksSession(t *testing.T) {
	auth, _ := newTestGateway()
	auth.policy.set(true, false)
	principal, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "被拒绝", AccessType: "anonymous"})
	if errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}

	record := auth.records.list()[0]
	reviewed, ok := auth.records.review(record.ID, "rejected", "admin-user")
	if !ok || reviewed.Status != "rejected" {
		t.Fatalf("unexpected review result: %#v ok=%v", reviewed, ok)
	}
	auth.setUserStatus(reviewed.UserID, reviewed.Status)

	handler := requireActive(auth, "demo", okHandler)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for rejected session, got %d", recorder.Code)
	}
	if body := recordedBody(t, recorder); body["error"] != "ACCESS_REJECTED" {
		t.Fatalf("expected ACCESS_REJECTED error, got %#v", body)
	}
}

func TestReviewTransitionsFromPendingOnly(t *testing.T) {
	records := newAccessStore()
	id := records.add(&accessRecord{DisplayName: "甲", AccessType: "anonymous", Status: "pending"})

	first, ok := records.review(id, "active", "admin-user")
	if !ok || first.Status != "active" {
		t.Fatalf("first review should succeed: %#v ok=%v", first, ok)
	}
	second, ok := records.review(id, "active", "admin-user")
	if !ok || second.Status != "active" {
		t.Fatalf("repeated identical review should be idempotent: %#v ok=%v", second, ok)
	}
	if _, ok := records.review(id, "rejected", "admin-user"); ok {
		t.Fatal("review should not change a decided record to a different status")
	}
	if _, ok := records.review("acc_missing", "active", "admin-user"); ok {
		t.Fatal("review of unknown record should fail")
	}
}

func TestFullAnonymousRequiresPolicyAndIssuesActiveGuest(t *testing.T) {
	auth, _ := newTestGateway()

	if _, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", AccessType: "guest"}); errCode != "ACCESS_DENIED" {
		t.Fatalf("expected guest denied while policy off, got %q", errCode)
	}

	auth.policy.set(false, true)
	principal, record, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", AccessType: "guest"})
	if errCode != "" {
		t.Fatalf("expected guest accepted while policy on, got %q", errCode)
	}
	if principal.Status != "active" || record.Status != "active" || record.AccessType != "guest" {
		t.Fatalf("unexpected guest principal/record: %#v %#v", principal, record)
	}
	if !strings.HasPrefix(principal.DisplayName, "访客") {
		t.Fatalf("expected guest display name prefix 访客, got %q", principal.DisplayName)
	}
}

func TestAccessRecordsListedNewestFirst(t *testing.T) {
	auth, _ := newTestGateway()
	issueLogin(t, auth, "第一个")
	issueLogin(t, auth, "第二个")
	issueLogin(t, auth, "第三个")

	records := auth.records.list()
	if len(records) != 3 {
		t.Fatalf("expected 3 records, got %d", len(records))
	}
	if records[0].DisplayName != "第三个" || records[2].DisplayName != "第一个" {
		t.Fatalf("expected newest-first order, got %#v", records)
	}
}

func TestRequireAdminEnforcesRole(t *testing.T) {
	auth, _ := newTestGateway()
	handler := requireAdmin(auth, okHandler)

	unauthenticated := httptest.NewRecorder()
	handler(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/v1/admin/access-policy", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", unauthenticated.Code)
	}

	member := issueLogin(t, auth, "成员")
	memberRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/access-policy", nil)
	memberRequest.Header.Set("Authorization", "Bearer "+member.Token)
	memberRecorder := httptest.NewRecorder()
	handler(memberRecorder, memberRequest)
	if memberRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for member, got %d", memberRecorder.Code)
	}

	admin, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "管理员", AccessType: "login", Passcode: "test-passcode"})
	if errCode != "" {
		t.Fatalf("issue admin session: %s", errCode)
	}
	adminRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/access-policy", nil)
	adminRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	adminRecorder := httptest.NewRecorder()
	handler(adminRecorder, adminRequest)
	if adminRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin, got %d", adminRecorder.Code)
	}
}

func TestSessionEndpointIssuesByAccessType(t *testing.T) {
	auth, hub := newTestGateway()
	handler := handleSessionIssue(auth, hub, newAuditStore(), newRateLimiter(1000, 1000))

	post := func(body map[string]interface{}) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler(recorder, request)
		return recorder
	}

	if recorder := post(map[string]interface{}{"workspaceId": "demo", "accessType": "guest"}); recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for guest while policy off, got %d body=%s", recorder.Code, recorder.Body.String())
	}

	auth.policy.set(true, true)

	guestRecorder := post(map[string]interface{}{"workspaceId": "demo", "accessType": "guest"})
	if guestRecorder.Code != http.StatusCreated {
		t.Fatalf("expected 201 for guest, got %d body=%s", guestRecorder.Code, guestRecorder.Body.String())
	}
	guestBody := recordedBody(t, guestRecorder)
	if guestBody["accessType"] != "guest" || guestBody["status"] != "active" || guestBody["accessToken"] == "" {
		t.Fatalf("unexpected guest session body: %#v", guestBody)
	}

	anonymousRecorder := post(map[string]interface{}{"workspaceId": "demo", "displayName": "申请者", "accessType": "anonymous", "note": "申请理由"})
	if anonymousRecorder.Code != http.StatusCreated {
		t.Fatalf("expected 201 for anonymous application, got %d", anonymousRecorder.Code)
	}
	anonymousBody := recordedBody(t, anonymousRecorder)
	if anonymousBody["accessType"] != "anonymous" || anonymousBody["status"] != "pending" {
		t.Fatalf("unexpected anonymous session body: %#v", anonymousBody)
	}

	emitted, complete := hub.store.Since(0)
	if !complete || len(emitted) != 2 {
		t.Fatalf("expected 2 emitted access events, got %d complete=%v", len(emitted), complete)
	}
	for _, event := range emitted {
		if event.Type != "access.record.created" {
			t.Fatalf("expected access.record.created events, got %q", event.Type)
		}
	}
}

func TestMeEndpointReturnsSessionState(t *testing.T) {
	auth, _ := newTestGateway()
	handler := handleMe(auth)

	auth.policy.set(true, false)
	principal, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "等待中", AccessType: "anonymous"})
	if errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	body := recordedBody(t, recorder)
	if body["userId"] != principal.UserID || body["status"] != "pending" || body["accessType"] != "anonymous" || body["role"] != "member" {
		t.Fatalf("unexpected me body: %#v", body)
	}

	unauthorized := httptest.NewRecorder()
	handler(unauthorized, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", unauthorized.Code)
	}
}

func TestAdminPolicyEndpoints(t *testing.T) {
	auth, hub := newTestGateway()
	mux := http.NewServeMux()
	registerAccessRoutes(mux, auth, hub, newAuditStore(), newRateLimiter(1000, 1000))

	admin, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "管理员", AccessType: "login", Passcode: "test-passcode"})
	if errCode != "" {
		t.Fatalf("issue admin session: %s", errCode)
	}
	member := issueLogin(t, auth, "成员")

	publicRecorder := httptest.NewRecorder()
	mux.ServeHTTP(publicRecorder, httptest.NewRequest(http.MethodGet, "/api/v1/access-policy", nil))
	if publicRecorder.Code != http.StatusOK {
		t.Fatalf("expected public policy 200, got %d", publicRecorder.Code)
	}
	publicPolicy := recordedBody(t, publicRecorder)
	if publicPolicy["allowAnonymousApplication"] != false || publicPolicy["allowFullAnonymous"] != false {
		t.Fatalf("expected default policy off, got %#v", publicPolicy)
	}

	patchRaw := []byte(`{"allowAnonymousApplication": true, "allowFullAnonymous": true}`)
	memberRequest := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/access-policy", bytes.NewReader(patchRaw))
	memberRequest.Header.Set("Authorization", "Bearer "+member.Token)
	memberRecorder := httptest.NewRecorder()
	mux.ServeHTTP(memberRecorder, memberRequest)
	if memberRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for member patch, got %d", memberRecorder.Code)
	}

	adminRequest := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/access-policy", bytes.NewReader(patchRaw))
	adminRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	adminRecorder := httptest.NewRecorder()
	mux.ServeHTTP(adminRecorder, adminRequest)
	if adminRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin patch, got %d body=%s", adminRecorder.Code, adminRecorder.Body.String())
	}
	updated := recordedBody(t, adminRecorder)
	if updated["allowAnonymousApplication"] != true || updated["allowFullAnonymous"] != true {
		t.Fatalf("expected policy updated, got %#v", updated)
	}

	emitted, complete := hub.store.Since(0)
	if !complete || len(emitted) == 0 || emitted[len(emitted)-1].Type != "access.policy.updated" {
		t.Fatalf("expected access.policy.updated event, got %#v", emitted)
	}
}

func TestAdminRecordReviewRoutes(t *testing.T) {
	auth, hub := newTestGateway()
	mux := http.NewServeMux()
	registerAccessRoutes(mux, auth, hub, newAuditStore(), newRateLimiter(1000, 1000))

	auth.policy.set(true, false)
	principal, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "申请者", AccessType: "anonymous"})
	if errCode != "" {
		t.Fatalf("issue anonymous: %s", errCode)
	}
	admin, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "管理员", AccessType: "login", Passcode: "test-passcode"})
	if errCode != "" {
		t.Fatalf("issue admin session: %s", errCode)
	}
	var recordID string
	for _, record := range auth.records.list() {
		if record.AccessType == "anonymous" && record.Status == "pending" {
			recordID = record.ID
		}
	}
	if recordID == "" {
		t.Fatal("expected a pending anonymous record")
	}

	listRecorder := httptest.NewRecorder()
	listRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/access-records", nil)
	listRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	mux.ServeHTTP(listRecorder, listRequest)
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("expected records list 200, got %d", listRecorder.Code)
	}
	listBody := recordedBody(t, listRecorder)
	items, _ := listBody["items"].([]interface{})
	if len(items) != 2 {
		t.Fatalf("expected 2 records (applicant + admin), got %#v", listBody)
	}

	approveRequest := httptest.NewRequest(http.MethodPost, "/api/v1/admin/access-records/"+recordID+"/approve", nil)
	approveRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	approveRecorder := httptest.NewRecorder()
	mux.ServeHTTP(approveRecorder, approveRequest)
	if approveRecorder.Code != http.StatusOK {
		t.Fatalf("expected approve 200, got %d body=%s", approveRecorder.Code, approveRecorder.Body.String())
	}
	approved := recordedBody(t, approveRecorder)
	if approved["status"] != "active" {
		t.Fatalf("expected approved record, got %#v", approved)
	}

	businessRequest := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	businessRequest.Header.Set("Authorization", "Bearer "+principal.Token)
	businessRecorder := httptest.NewRecorder()
	requireActive(auth, "demo", okHandler)(businessRecorder, businessRequest)
	if businessRecorder.Code != http.StatusOK {
		t.Fatalf("expected approved session to access business routes, got %d", businessRecorder.Code)
	}

	missingRecorder := httptest.NewRecorder()
	missingRequest := httptest.NewRequest(http.MethodPost, "/api/v1/admin/access-records/acc_missing/reject", nil)
	missingRequest.Header.Set("Authorization", "Bearer "+admin.Token)
	mux.ServeHTTP(missingRecorder, missingRequest)
	if missingRecorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown record, got %d", missingRecorder.Code)
	}
}
