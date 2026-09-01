package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const defaultAdminPasscode = "linkos-admin"

func adminPasscode() string {
	if code := strings.TrimSpace(os.Getenv("LINKOS_ADMIN_PASSCODE")); code != "" {
		return code
	}
	return defaultAdminPasscode
}

type accessPolicy struct {
	mu                        sync.Mutex
	backend                   persistBackend
	allowAnonymousApplication bool
	allowFullAnonymous        bool
}

func newAccessPolicy() *accessPolicy { return newAccessPolicyWithBackend(memoryBackend{}) }

func newAccessPolicyWithBackend(backend persistBackend) *accessPolicy {
	p := &accessPolicy{backend: backend}
	state, ok, err := backend.loadPolicy()
	if err != nil {
		log.Printf("load access policy: %v", err)
		return p
	}
	if ok {
		p.allowAnonymousApplication = state.AllowAnonymousApplication
		p.allowFullAnonymous = state.AllowFullAnonymous
	}
	return p
}

func (p *accessPolicy) get() (allowAnonymousApplication bool, allowFullAnonymous bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.allowAnonymousApplication, p.allowFullAnonymous
}

func (p *accessPolicy) set(allowAnonymousApplication, allowFullAnonymous bool) {
	p.mu.Lock()
	p.allowAnonymousApplication = allowAnonymousApplication
	p.allowFullAnonymous = allowFullAnonymous
	state := policyState{AllowAnonymousApplication: allowAnonymousApplication, AllowFullAnonymous: allowFullAnonymous}
	p.mu.Unlock()
	if err := p.backend.savePolicy(state); err != nil {
		log.Printf("persist access policy: %v", err)
	}
}

type accessPolicyView struct {
	AllowAnonymousApplication bool `json:"allowAnonymousApplication"`
	AllowFullAnonymous        bool `json:"allowFullAnonymous"`
}

func (p *accessPolicy) view() accessPolicyView {
	allowAnonymous, allowFull := p.get()
	return accessPolicyView{AllowAnonymousApplication: allowAnonymous, AllowFullAnonymous: allowFull}
}

type accessRecord struct {
	ID          string
	UserID      string
	DisplayName string
	AccessType  string
	Status      string
	CreatedAt   time.Time
	ReviewedAt  time.Time
	ReviewedBy  string
	Note        string
	RemoteAddr  string
}

type accessRecordView struct {
	ID          string `json:"id"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	AccessType  string `json:"accessType"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt"`
	ReviewedAt  string `json:"reviewedAt,omitempty"`
	ReviewedBy  string `json:"reviewedBy,omitempty"`
	Note        string `json:"note,omitempty"`
	RemoteAddr  string `json:"remoteAddr,omitempty"`
}

func accessRecordToView(record *accessRecord) accessRecordView {
	view := accessRecordView{
		ID:          record.ID,
		UserID:      record.UserID,
		DisplayName: record.DisplayName,
		AccessType:  record.AccessType,
		Status:      record.Status,
		CreatedAt:   record.CreatedAt.Format(time.RFC3339),
		ReviewedBy:  record.ReviewedBy,
		Note:        record.Note,
		RemoteAddr:  record.RemoteAddr,
	}
	if !record.ReviewedAt.IsZero() {
		view.ReviewedAt = record.ReviewedAt.Format(time.RFC3339)
	}
	return view
}

type accessStore struct {
	mu      sync.Mutex
	backend persistBackend
	records map[string]*accessRecord
	order   []string
	counter int
}

func newAccessStore() *accessStore { return newAccessStoreWithBackend(memoryBackend{}) }

func newAccessStoreWithBackend(backend persistBackend) *accessStore {
	s := &accessStore{backend: backend, records: make(map[string]*accessRecord)}
	stored, counter, err := backend.loadAccessRecords()
	if err != nil {
		log.Printf("load access records: %v", err)
		return s
	}
	for i := range stored {
		record := stored[i]
		s.records[record.ID] = &record
		s.order = append(s.order, record.ID)
	}
	s.counter = counter
	return s
}

func (s *accessStore) add(record *accessRecord) string {
	s.mu.Lock()
	s.counter++
	id := fmt.Sprintf("acc_%d", s.counter)
	record.ID = id
	stored := *record
	s.records[id] = &stored
	s.order = append(s.order, id)
	s.mu.Unlock()
	if err := s.backend.appendAccessRecord(stored); err != nil {
		log.Printf("persist access record %s: %v", id, err)
	}
	return id
}

func (s *accessStore) list() []accessRecordView {
	s.mu.Lock()
	defer s.mu.Unlock()
	views := make([]accessRecordView, 0, len(s.order))
	for i := len(s.order) - 1; i >= 0; i-- {
		views = append(views, accessRecordToView(s.records[s.order[i]]))
	}
	return views
}

// review transitions a pending record to the decided status. Repeating the
// same decision is idempotent; any other transition is refused.
func (s *accessStore) review(id, status, reviewer string) (accessRecordView, bool) {
	s.mu.Lock()
	record, ok := s.records[id]
	if !ok {
		s.mu.Unlock()
		return accessRecordView{}, false
	}
	if record.Status == status {
		view := accessRecordToView(record)
		s.mu.Unlock()
		return view, true
	}
	if record.Status != accessStatusPending {
		s.mu.Unlock()
		return accessRecordView{}, false
	}
	record.Status = status
	record.ReviewedAt = time.Now().UTC()
	record.ReviewedBy = reviewer
	updated := *record
	view := accessRecordToView(record)
	s.mu.Unlock()
	if err := s.backend.updateAccessRecord(updated); err != nil {
		log.Printf("persist access record %s: %v", id, err)
	}
	return view, true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func handleSessionIssue(auth *authStore, h *hub, audit *auditStore, limiter *rateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		if !limiter.allow(clientIP(r)) {
			writeAPIError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many session requests, retry later")
			return
		}
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DisplayName string `json:"displayName"`
			AccessType  string `json:"accessType"`
			Passcode    string `json:"passcode"`
			Note        string `json:"note"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		principal, record, errCode := auth.issueSession(sessionRequest{
			WorkspaceID: body.WorkspaceID,
			DisplayName: body.DisplayName,
			AccessType:  body.AccessType,
			Passcode:    body.Passcode,
			Note:        body.Note,
			RemoteAddr:  r.RemoteAddr,
		})
		switch errCode {
		case "":
			audit.record(auditEntry{
				ActorUserID: principal.UserID,
				ActorName:   principal.DisplayName,
				Action:      auditActionSessionIssue,
				Target:      record.ID,
				Detail:      principal.AccessType,
				RemoteAddr:  r.RemoteAddr,
			})
			h.emit("access.record.created", accessRecordToView(&record))
			writeJSON(w, http.StatusCreated, map[string]interface{}{
				"accessToken": principal.Token,
				"expiresIn":   int(sessionTTL.Seconds()),
				"workspaceId": principal.WorkspaceID,
				"userId":      principal.UserID,
				"displayName": principal.DisplayName,
				"role":        principal.Role,
				"accessType":  principal.AccessType,
				"status":      principal.Status,
			})
		case "ACCESS_DENIED":
			requestedType := strings.TrimSpace(body.AccessType)
			if requestedType == "" {
				requestedType = accessTypeLogin
			}
			audit.record(auditEntry{
				Action:     auditActionSessionDenied,
				Detail:     requestedType,
				RemoteAddr: r.RemoteAddr,
			})
			writeAPIError(w, http.StatusForbidden, "ACCESS_DENIED", "access mode is disabled by workspace policy")
		case "INTERNAL_ERROR":
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create workspace session")
		default:
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "session request is invalid")
		}
	}
}

func handleMe(auth *authStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.authenticateRequest(r, "")
		if !ok {
			writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "valid workspace session required")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"userId":      principal.UserID,
			"displayName": principal.DisplayName,
			"role":        principal.Role,
			"accessType":  principal.AccessType,
			"status":      principal.Status,
			"workspaceId": principal.WorkspaceID,
		})
	}
}

func handlePublicPolicy(policy *accessPolicy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		writeJSON(w, http.StatusOK, policy.view())
	}
}

type accessAdmin struct {
	auth  *authStore
	hub   *hub
	audit *auditStore
}

func (a *accessAdmin) handlePolicy(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.auth.policy.view())
	case http.MethodPatch:
		var patch struct {
			AllowAnonymousApplication *bool `json:"allowAnonymousApplication"`
			AllowFullAnonymous        *bool `json:"allowFullAnonymous"`
		}
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil || (patch.AllowAnonymousApplication == nil && patch.AllowFullAnonymous == nil) {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "policy patch requires at least one boolean field")
			return
		}
		allowAnonymous, allowFull := a.auth.policy.get()
		if patch.AllowAnonymousApplication != nil {
			allowAnonymous = *patch.AllowAnonymousApplication
		}
		if patch.AllowFullAnonymous != nil {
			allowFull = *patch.AllowFullAnonymous
		}
		a.auth.policy.set(allowAnonymous, allowFull)
		view := a.auth.policy.view()
		entry := auditEntry{
			Action:     auditActionPolicyUpdate,
			Detail:     fmt.Sprintf("allowAnonymousApplication=%t allowFullAnonymous=%t", view.AllowAnonymousApplication, view.AllowFullAnonymous),
			RemoteAddr: r.RemoteAddr,
		}
		if principal, ok := a.auth.authenticateRequest(r, ""); ok {
			entry.ActorUserID = principal.UserID
			entry.ActorName = principal.DisplayName
		}
		a.audit.record(entry)
		a.hub.emit("access.policy.updated", view)
		writeJSON(w, http.StatusOK, view)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}
}

func (a *accessAdmin) handleRecords(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": a.auth.records.list()})
}

func (a *accessAdmin) handleRecordAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/access-records/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || (parts[1] != "approve" && parts[1] != "reject") {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "unknown record action")
		return
	}
	status := accessStatusActive
	eventType := "access.record.approved"
	auditAction := auditActionRecordApprove
	if parts[1] == "reject" {
		status = accessStatusRejected
		eventType = "access.record.rejected"
		auditAction = auditActionRecordReject
	}
	reviewer := "admin"
	var reviewerPrincipal authPrincipal
	var authenticated bool
	if principal, ok := a.auth.authenticateRequest(r, ""); ok {
		reviewer = principal.UserID
		reviewerPrincipal = principal
		authenticated = true
	}
	view, ok := a.auth.records.review(parts[0], status, reviewer)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "access record not found or already decided")
		return
	}
	a.auth.setUserStatus(view.UserID, view.Status)
	entry := auditEntry{
		Action:     auditAction,
		Target:     parts[0],
		Detail:     view.UserID,
		RemoteAddr: r.RemoteAddr,
	}
	if authenticated {
		entry.ActorUserID = reviewerPrincipal.UserID
		entry.ActorName = reviewerPrincipal.DisplayName
	}
	a.audit.record(entry)
	a.hub.emit(eventType, view)
	writeJSON(w, http.StatusOK, view)
}

func requireAdmin(auth *authStore, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.authenticateRequest(r, "")
		if !ok {
			writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "valid workspace session required")
			return
		}
		if principal.Role != roleAdmin {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "admin role required")
			return
		}
		handler(w, r)
	}
}

func registerAccessRoutes(mux *http.ServeMux, auth *authStore, h *hub, audit *auditStore, limiter *rateLimiter) {
	admin := &accessAdmin{auth: auth, hub: h, audit: audit}
	mux.HandleFunc("/api/v1/sessions", handleSessionIssue(auth, h, audit, limiter))
	mux.HandleFunc("/api/v1/me", handleMe(auth))
	mux.HandleFunc("/api/v1/access-policy", handlePublicPolicy(auth.policy))
	mux.HandleFunc("/api/v1/admin/access-policy", requireAdmin(auth, admin.handlePolicy))
	mux.HandleFunc("/api/v1/admin/access-records", requireAdmin(auth, admin.handleRecords))
	mux.HandleFunc("/api/v1/admin/access-records/", requireAdmin(auth, admin.handleRecordAction))
	mux.HandleFunc("/api/v1/admin/audit-log", requireAdmin(auth, handleAuditLog(audit)))
}
