package main

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
)

const sessionTTL = time.Hour

type authPrincipal struct {
	Token       string
	UserID      string
	DisplayName string
	WorkspaceID string
	Role        string
	ExpiresAt   time.Time
}

type authStore struct {
	mu          sync.Mutex
	workspaceID string
	sessions    map[string]authPrincipal
}

func newAuthStore(workspaceID string) *authStore {
	return &authStore{workspaceID: workspaceID, sessions: make(map[string]authPrincipal)}
}

func (a *authStore) issue(workspaceID, displayName string) (authPrincipal, bool) {
	if workspaceID == "" {
		workspaceID = a.workspaceID
	}
	if workspaceID != a.workspaceID {
		return authPrincipal{}, false
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return authPrincipal{}, false
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if strings.TrimSpace(displayName) == "" {
		displayName = "本地设备"
	}
	now := time.Now().UTC()
	principal := authPrincipal{
		Token:       token,
		UserID:      "usr_" + token[:12],
		DisplayName: strings.TrimSpace(displayName),
		WorkspaceID: workspaceID,
		Role:        "member",
		ExpiresAt:   now.Add(sessionTTL),
	}
	a.mu.Lock()
	a.sessions[token] = principal
	a.mu.Unlock()
	return principal, true
}

func (a *authStore) authenticateRequest(r *http.Request, workspaceID string) (authPrincipal, bool) {
	token := requestToken(r)
	if token == "" {
		return authPrincipal{}, false
	}
	a.mu.Lock()
	principal, ok := a.sessions[token]
	if ok && time.Now().UTC().After(principal.ExpiresAt) {
		delete(a.sessions, token)
		ok = false
	}
	a.mu.Unlock()
	if !ok || principal.WorkspaceID != a.workspaceID || (workspaceID != "" && principal.WorkspaceID != workspaceID) {
		return authPrincipal{}, false
	}
	return principal, true
}

func requestToken(r *http.Request) string {
	if raw := strings.TrimSpace(r.Header.Get("Authorization")); raw != "" {
		parts := strings.Fields(raw)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			return parts[1]
		}
	}
	return strings.TrimSpace(r.URL.Query().Get("access_token"))
}

func requireWorkspace(auth *authStore, workspaceID string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := auth.authenticateRequest(r, workspaceID); !ok {
			writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "valid workspace session required")
			return
		}
		handler(w, r)
	}
}
