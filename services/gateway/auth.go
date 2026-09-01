package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
)

const sessionTTL = time.Hour

const (
	roleMember = "member"
	roleAdmin  = "admin"

	accessTypeLogin     = "login"
	accessTypeAnonymous = "anonymous"
	accessTypeGuest     = "guest"

	accessStatusPending  = "pending"
	accessStatusActive   = "active"
	accessStatusRejected = "rejected"
)

type authPrincipal struct {
	Token       string
	UserID      string
	DisplayName string
	WorkspaceID string
	Role        string
	AccessType  string
	Status      string
	ExpiresAt   time.Time
}

type sessionRequest struct {
	WorkspaceID string
	DisplayName string
	AccessType  string
	Passcode    string
	Note        string
	RemoteAddr  string
}

type authStore struct {
	mu             sync.Mutex
	workspaceID    string
	adminPasscode  string
	policy         *accessPolicy
	records        *accessStore
	sessions       map[string]authPrincipal
	sessionsByUser map[string][]string
}

func newAuthStore(workspaceID, adminPasscode string, policy *accessPolicy, records *accessStore) *authStore {
	return &authStore{
		workspaceID:    workspaceID,
		adminPasscode:  adminPasscode,
		policy:         policy,
		records:        records,
		sessions:       make(map[string]authPrincipal),
		sessionsByUser: make(map[string][]string),
	}
}

func (a *authStore) issueSession(req sessionRequest) (authPrincipal, accessRecord, string) {
	workspaceID := req.WorkspaceID
	if workspaceID == "" {
		workspaceID = a.workspaceID
	}
	if workspaceID != a.workspaceID {
		return authPrincipal{}, accessRecord{}, "INVALID_REQUEST"
	}

	accessType := strings.TrimSpace(req.AccessType)
	if accessType == "" {
		accessType = accessTypeLogin
	}
	allowAnonymous, allowFull := a.policy.get()
	status := accessStatusActive
	role := roleMember
	displayName := strings.TrimSpace(req.DisplayName)

	switch accessType {
	case accessTypeLogin:
		if displayName == "" {
			return authPrincipal{}, accessRecord{}, "INVALID_REQUEST"
		}
		passcode := strings.TrimSpace(req.Passcode)
		if passcode != "" {
			if subtle.ConstantTimeCompare([]byte(passcode), []byte(a.adminPasscode)) != 1 {
				return authPrincipal{}, accessRecord{}, "INVALID_REQUEST"
			}
			role = roleAdmin
		}
	case accessTypeAnonymous:
		if !allowAnonymous {
			return authPrincipal{}, accessRecord{}, "ACCESS_DENIED"
		}
		if displayName == "" {
			displayName = "匿名访客"
		}
		status = accessStatusPending
	case accessTypeGuest:
		if !allowFull {
			return authPrincipal{}, accessRecord{}, "ACCESS_DENIED"
		}
	default:
		return authPrincipal{}, accessRecord{}, "INVALID_REQUEST"
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return authPrincipal{}, accessRecord{}, "INTERNAL_ERROR"
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if accessType == accessTypeGuest {
		displayName = "访客-" + token[:6]
	}

	now := time.Now().UTC()
	principal := authPrincipal{
		Token:       token,
		UserID:      "usr_" + token[:12],
		DisplayName: displayName,
		WorkspaceID: workspaceID,
		Role:        role,
		AccessType:  accessType,
		Status:      status,
		ExpiresAt:   now.Add(sessionTTL),
	}

	record := accessRecord{
		UserID:      principal.UserID,
		DisplayName: displayName,
		AccessType:  accessType,
		Status:      status,
		CreatedAt:   now,
		Note:        strings.TrimSpace(req.Note),
		RemoteAddr:  req.RemoteAddr,
	}
	a.records.add(&record)

	a.mu.Lock()
	a.sessions[token] = principal
	a.sessionsByUser[principal.UserID] = append(a.sessionsByUser[principal.UserID], token)
	a.mu.Unlock()

	return principal, record, ""
}

func (a *authStore) setUserStatus(userID, status string) {
	a.mu.Lock()
	for _, token := range a.sessionsByUser[userID] {
		if principal, ok := a.sessions[token]; ok {
			principal.Status = status
			a.sessions[token] = principal
		}
	}
	a.mu.Unlock()
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

func requireActive(auth *authStore, workspaceID string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.authenticateRequest(r, workspaceID)
		if !ok {
			writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "valid workspace session required")
			return
		}
		switch principal.Status {
		case accessStatusActive:
			handler(w, r)
		case accessStatusPending:
			writeAPIError(w, http.StatusForbidden, "ACCESS_PENDING", "access application is awaiting review")
		case accessStatusRejected:
			writeAPIError(w, http.StatusForbidden, "ACCESS_REJECTED", "access application was rejected")
		default:
			writeAPIError(w, http.StatusForbidden, "ACCESS_REVOKED", "access has been revoked")
		}
	}
}
