package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestAuth() *authStore {
	return newAuthStore("demo", "test-passcode", newAccessPolicy(), newAccessStore())
}

func issueLogin(t *testing.T, auth *authStore, name string) authPrincipal {
	t.Helper()
	principal, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo",
		DisplayName: name,
		AccessType:  "login",
	})
	if errCode != "" {
		t.Fatalf("issue login session failed: %s", errCode)
	}
	return principal
}

func TestLoginSessionIssuesAndValidatesWorkspaceSession(t *testing.T) {
	auth := newTestAuth()
	principal := issueLogin(t, auth, "测试设备")
	if principal.Token == "" || principal.WorkspaceID != "demo" {
		t.Fatalf("unexpected principal: %#v", principal)
	}
	if principal.Role != "member" || principal.AccessType != "login" || principal.Status != "active" {
		t.Fatalf("unexpected principal fields: %#v", principal)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	validated, ok := auth.authenticateRequest(request, "demo")
	if !ok || validated.UserID != principal.UserID {
		t.Fatalf("expected valid session, got %#v, %v", validated, ok)
	}

	request.Header.Set("Authorization", "Bearer invalid")
	if _, ok := auth.authenticateRequest(request, "demo"); ok {
		t.Fatal("expected invalid token to be rejected")
	}
	if _, ok := auth.authenticateRequest(request, "other"); ok {
		t.Fatal("expected workspace mismatch to be rejected")
	}
}

func TestAuthStoreRejectsExpiredSession(t *testing.T) {
	auth := newTestAuth()
	principal := issueLogin(t, auth, "过期设备")

	auth.mu.Lock()
	stored := auth.sessions[principal.Token]
	stored.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	auth.sessions[principal.Token] = stored
	auth.mu.Unlock()

	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	if _, ok := auth.authenticateRequest(request, "demo"); ok {
		t.Fatal("expected expired token to be rejected")
	}
	auth.mu.Lock()
	_, stillStored := auth.sessions[principal.Token]
	auth.mu.Unlock()
	if stillStored {
		t.Fatal("expired token should be removed")
	}
}

func TestRequireActiveReturnsUnauthorizedWithoutSession(t *testing.T) {
	auth := newTestAuth()
	handler := requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	unauthorized := httptest.NewRecorder()
	handler(unauthorized, httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorized.Code)
	}

	principal := issueLogin(t, auth, "有效设备")
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer "+principal.Token)
	authorized := httptest.NewRecorder()
	handler(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorized.Code)
	}
}
