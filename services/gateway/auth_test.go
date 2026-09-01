package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuthStoreIssuesAndValidatesWorkspaceSession(t *testing.T) {
	auth := newAuthStore("demo")
	principal, ok := auth.issue("demo", "测试设备")
	if !ok || principal.Token == "" || principal.WorkspaceID != "demo" {
		t.Fatalf("unexpected principal: %#v", principal)
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
	auth := newAuthStore("demo")
	principal, ok := auth.issue("demo", "过期设备")
	if !ok {
		t.Fatal("issue session failed")
	}
	auth.mu.Lock()
	principal.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	auth.sessions[principal.Token] = principal
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

func TestRequireWorkspaceReturnsUnauthorizedWithoutSession(t *testing.T) {
	auth := newAuthStore("demo")
	handler := requireWorkspace(auth, "demo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	unauthorized := httptest.NewRecorder()
	handler(unauthorized, httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorized.Code)
	}

	principal, ok := auth.issue("demo", "有效设备")
	if !ok {
		t.Fatal("issue session failed")
	}
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer "+principal.Token)
	authorized := httptest.NewRecorder()
	handler(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorized.Code)
	}
}
