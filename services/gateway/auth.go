package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const sessionTTL = time.Hour
const refreshTTL = 30 * 24 * time.Hour

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

func roleAllows(role, permission string) bool {
	switch role {
	case "owner", roleAdmin:
		return true
	case roleMember:
		switch permission {
		case "workspace.read", "resource.read", "resource.write", "chat.read", "chat.send", "code.read", "code.write", "code.run", "job.submit", "job.cancel", "runner.read", "plugin.read":
			return true
		}
	case "guest":
		return permission == "workspace.read" || permission == "resource.read" || permission == "chat.read" || permission == "code.read" || permission == "runner.read" || permission == "plugin.read"
	}
	return false
}

type authPrincipal struct {
	Token        string
	UserID       string
	DisplayName  string
	WorkspaceID  string
	Role         string
	AccessType   string
	Status       string
	ExpiresAt    time.Time
	RefreshToken string
	DeviceID     string
}

type deviceRecord struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	WorkspaceID string    `json:"workspaceId"`
	DisplayName string    `json:"displayName"`
	PublicKey   string    `json:"publicKey"`
	CreatedAt   time.Time `json:"createdAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
	RevokedAt   time.Time `json:"revokedAt,omitempty"`
}

type refreshRecord struct {
	UserID      string    `json:"userId"`
	DeviceID    string    `json:"deviceId"`
	DisplayName string    `json:"displayName"`
	WorkspaceID string    `json:"workspaceId"`
	Role        string    `json:"role"`
	AccessType  string    `json:"accessType"`
	Status      string    `json:"status"`
	ExpiresAt   time.Time `json:"expiresAt"`
	Revoked     bool      `json:"revoked"`
}

type sessionRequest struct {
	WorkspaceID string
	DisplayName string
	AccessType  string
	Passcode    string
	Note        string
	RemoteAddr  string
	DeviceID    string
	PublicKey   string
	InviteCode  string
}

type authStore struct {
	mu             sync.Mutex
	workspaceID    string
	adminPasscode  string
	policy         *accessPolicy
	records        *accessStore
	sessions       map[string]authPrincipal
	sessionsByUser map[string][]string
	refreshTokens  map[string]refreshRecord
	devices        map[string]deviceRecord
	invites        map[string]time.Time
	usedInvites    map[string]bool
}

type memberView struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	DeviceCount int    `json:"deviceCount"`
}

type persistedAuthState struct {
	RefreshTokens map[string]refreshRecord `json:"refreshTokens"`
	Devices       map[string]deviceRecord  `json:"devices"`
	Invites       map[string]time.Time     `json:"invites"`
	UsedInvites   map[string]bool          `json:"usedInvites"`
}

func newAuthStore(workspaceID, adminPasscode string, policy *accessPolicy, records *accessStore) *authStore {
	a := &authStore{
		workspaceID:    workspaceID,
		adminPasscode:  adminPasscode,
		policy:         policy,
		records:        records,
		sessions:       make(map[string]authPrincipal),
		sessionsByUser: make(map[string][]string),
		refreshTokens:  make(map[string]refreshRecord),
		devices:        make(map[string]deviceRecord),
		invites:        make(map[string]time.Time),
		usedInvites:    make(map[string]bool),
	}
	if durable, ok := any(records.backend).(authStateBackend); ok {
		if raw, err := durable.loadAuthState(); err == nil && len(raw) > 0 {
			var state persistedAuthState
			if err := json.Unmarshal(raw, &state); err != nil {
				log.Printf("load auth state: %v", err)
			} else {
				for token, record := range state.RefreshTokens {
					if time.Now().UTC().Before(record.ExpiresAt) && !record.Revoked {
						a.refreshTokens[token] = record
					}
				}
				for id, device := range state.Devices {
					a.devices[id] = device
				}
				for code, expires := range state.Invites {
					a.invites[code] = expires
				}
				for code, used := range state.UsedInvites {
					a.usedInvites[code] = used
				}
			}
		} else if err != nil {
			log.Printf("load auth state: %v", err)
		}
	}
	return a
}

func (a *authStore) persistAuthLocked() {
	durable, ok := any(a.records.backend).(authStateBackend)
	if !ok {
		return
	}
	raw, err := json.Marshal(persistedAuthState{RefreshTokens: a.refreshTokens, Devices: a.devices, Invites: a.invites, UsedInvites: a.usedInvites})
	if err != nil {
		log.Printf("marshal auth state: %v", err)
		return
	}
	if err := durable.saveAuthState(raw); err != nil {
		log.Printf("persist auth state: %v", err)
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
	if code := strings.TrimSpace(req.InviteCode); code != "" {
		a.mu.Lock()
		expires, exists := a.invites[code]
		valid := exists && !a.usedInvites[code] && time.Now().UTC().Before(expires)
		if valid {
			a.usedInvites[code] = true
		}
		a.mu.Unlock()
		if !valid {
			return authPrincipal{}, accessRecord{}, "INVALID_REQUEST"
		}
	}
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
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return authPrincipal{}, accessRecord{}, "INTERNAL_ERROR"
	}
	refreshToken := base64.RawURLEncoding.EncodeToString(refreshBytes)
	if accessType == accessTypeGuest {
		displayName = "访客-" + token[:6]
	}

	now := time.Now().UTC()
	deviceID := strings.TrimSpace(req.DeviceID)
	if deviceID == "" {
		deviceID = "dev_" + token[:12]
	}
	userID := "usr_" + token[:12]
	a.mu.Lock()
	if existing, ok := a.devices[deviceID]; ok && existing.RevokedAt.IsZero() {
		userID = existing.UserID
		if displayName == "" {
			displayName = existing.DisplayName
		}
	}
	a.mu.Unlock()
	principal := authPrincipal{
		Token:        token,
		UserID:       userID,
		DisplayName:  displayName,
		WorkspaceID:  workspaceID,
		Role:         role,
		AccessType:   accessType,
		Status:       status,
		ExpiresAt:    now.Add(sessionTTL),
		RefreshToken: refreshToken,
		DeviceID:     deviceID,
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
	a.refreshTokens[refreshKey(refreshToken)] = refreshRecord{UserID: principal.UserID, DeviceID: deviceID, DisplayName: principal.DisplayName, WorkspaceID: principal.WorkspaceID, Role: principal.Role, AccessType: principal.AccessType, Status: principal.Status, ExpiresAt: now.Add(refreshTTL)}
	if strings.TrimSpace(req.PublicKey) != "" {
		a.devices[deviceID] = deviceRecord{ID: deviceID, UserID: principal.UserID, WorkspaceID: workspaceID, DisplayName: displayName, PublicKey: strings.TrimSpace(req.PublicKey), CreatedAt: now, LastSeenAt: now}
	}
	a.persistAuthLocked()
	a.mu.Unlock()

	return principal, record, ""
}

func (a *authStore) createInvite() (string, time.Time, bool) {
	bytes := make([]byte, 9)
	if _, err := rand.Read(bytes); err != nil {
		return "", time.Time{}, false
	}
	code := strings.ToUpper(base64.RawURLEncoding.EncodeToString(bytes))
	expires := time.Now().UTC().Add(10 * time.Minute)
	a.mu.Lock()
	a.invites[code] = expires
	a.persistAuthLocked()
	a.mu.Unlock()
	return code, expires, true
}

func (a *authStore) rotateRefresh(token string) (authPrincipal, bool) {
	a.mu.Lock()
	key := refreshKey(token)
	record, ok := a.refreshTokens[key]
	if !ok || record.Revoked || time.Now().UTC().After(record.ExpiresAt) {
		a.mu.Unlock()
		return authPrincipal{}, false
	}
	record.Revoked = true
	a.refreshTokens[key] = record
	base := authPrincipal{UserID: record.UserID, DeviceID: record.DeviceID, DisplayName: record.DisplayName, WorkspaceID: record.WorkspaceID, Role: record.Role, AccessType: record.AccessType, Status: record.Status}
	for _, principal := range a.sessions {
		if principal.UserID == record.UserID && principal.DeviceID == record.DeviceID {
			base = principal
			break
		}
	}
	a.mu.Unlock()
	if base.UserID == "" {
		return authPrincipal{}, false
	}
	accessBytes := make([]byte, 32)
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(accessBytes); err != nil {
		return authPrincipal{}, false
	}
	if _, err := rand.Read(refreshBytes); err != nil {
		return authPrincipal{}, false
	}
	now := time.Now().UTC()
	base.Token = base64.RawURLEncoding.EncodeToString(accessBytes)
	base.RefreshToken = base64.RawURLEncoding.EncodeToString(refreshBytes)
	base.ExpiresAt = now.Add(sessionTTL)
	a.mu.Lock()
	a.sessions[base.Token] = base
	a.sessionsByUser[base.UserID] = append(a.sessionsByUser[base.UserID], base.Token)
	a.refreshTokens[refreshKey(base.RefreshToken)] = refreshRecord{UserID: base.UserID, DeviceID: base.DeviceID, DisplayName: base.DisplayName, WorkspaceID: base.WorkspaceID, Role: base.Role, AccessType: base.AccessType, Status: base.Status, ExpiresAt: now.Add(refreshTTL)}
	a.persistAuthLocked()
	a.mu.Unlock()
	return base, true
}

func (a *authStore) revokeSession(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	principal, ok := a.sessions[token]
	if !ok {
		return false
	}
	delete(a.sessions, token)
	if principal.RefreshToken != "" {
		key := refreshKey(principal.RefreshToken)
		if record, exists := a.refreshTokens[key]; exists {
			record.Revoked = true
			a.refreshTokens[key] = record
		}
	}
	a.persistAuthLocked()
	return true
}

func refreshKey(token string) string {
	digest := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func (a *authStore) listDevices() []deviceRecord {
	a.mu.Lock()
	defer a.mu.Unlock()
	items := make([]deviceRecord, 0, len(a.devices))
	for _, item := range a.devices {
		items = append(items, item)
	}
	return items
}

func (a *authStore) listMembers() []memberView {
	a.mu.Lock()
	defer a.mu.Unlock()
	byUser := make(map[string]memberView)
	for _, principal := range a.sessions {
		member := byUser[principal.UserID]
		member.UserID, member.DisplayName, member.Role, member.Status = principal.UserID, principal.DisplayName, principal.Role, principal.Status
		byUser[principal.UserID] = member
	}
	for _, record := range a.refreshTokens {
		if record.Revoked {
			continue
		}
		member := byUser[record.UserID]
		if member.UserID == "" {
			member = memberView{UserID: record.UserID, DisplayName: record.DisplayName, Role: record.Role, Status: record.Status}
		}
		byUser[record.UserID] = member
	}
	for _, device := range a.devices {
		member := byUser[device.UserID]
		if member.UserID == "" {
			member = memberView{UserID: device.UserID, DisplayName: device.DisplayName, Role: roleMember, Status: accessStatusActive}
		}
		member.DeviceCount++
		byUser[device.UserID] = member
	}
	items := make([]memberView, 0, len(byUser))
	for _, member := range byUser {
		items = append(items, member)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].DisplayName < items[j].DisplayName })
	return items
}

func (a *authStore) setUserRole(userID, role string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	found := false
	for token, principal := range a.sessions {
		if principal.UserID == userID {
			principal.Role = role
			a.sessions[token] = principal
			found = true
		}
	}
	for token, record := range a.refreshTokens {
		if record.UserID == userID {
			record.Role = role
			a.refreshTokens[token] = record
			found = true
		}
	}
	if found {
		a.persistAuthLocked()
	}
	return found
}

func (a *authStore) revokeDevice(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	device, ok := a.devices[id]
	if !ok {
		return false
	}
	device.RevokedAt = time.Now().UTC()
	a.devices[id] = device
	for token, principal := range a.sessions {
		if principal.DeviceID == id {
			delete(a.sessions, token)
		}
	}
	for token, record := range a.refreshTokens {
		if record.DeviceID == id {
			record.Revoked = true
			a.refreshTokens[token] = record
		}
	}
	a.persistAuthLocked()
	return true
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
	if ok && principal.DeviceID != "" {
		if device, exists := a.devices[principal.DeviceID]; exists {
			if !device.RevokedAt.IsZero() {
				delete(a.sessions, token)
				ok = false
			} else {
				device.LastSeenAt = time.Now().UTC()
				a.devices[principal.DeviceID] = device
			}
		}
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
