package main

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

const (
	auditActionSessionIssue  = "session.issue"
	auditActionSessionDenied = "session.denied"
	auditActionPolicyUpdate  = "access.policy.update"
	auditActionRecordApprove = "access.record.approve"
	auditActionRecordReject  = "access.record.reject"

	auditCapacity = 2000
)

type auditEntry struct {
	ID          string
	At          time.Time
	ActorUserID string
	ActorName   string
	Action      string
	Target      string
	Detail      string
	RemoteAddr  string
}

type auditEntryView struct {
	ID          string `json:"id"`
	At          string `json:"at"`
	ActorUserID string `json:"actorUserId,omitempty"`
	ActorName   string `json:"actorName,omitempty"`
	Action      string `json:"action"`
	Target      string `json:"target,omitempty"`
	Detail      string `json:"detail,omitempty"`
	RemoteAddr  string `json:"remoteAddr,omitempty"`
}

func auditEntryToView(entry auditEntry) auditEntryView {
	return auditEntryView{
		ID:          entry.ID,
		At:          entry.At.Format(time.RFC3339),
		ActorUserID: entry.ActorUserID,
		ActorName:   entry.ActorName,
		Action:      entry.Action,
		Target:      entry.Target,
		Detail:      entry.Detail,
		RemoteAddr:  entry.RemoteAddr,
	}
}

// auditStore is an append-only, bounded audit trail. With a durable
// persistBackend the trail survives restarts; the memory backend keeps the
// previous ephemeral behavior for tests and the default dev mode.
type auditStore struct {
	mu      sync.Mutex
	backend persistBackend
	entries []auditEntry
	counter int
}

func newAuditStore() *auditStore { return newAuditStoreWithBackend(memoryBackend{}) }

func newAuditStoreWithBackend(backend persistBackend) *auditStore {
	s := &auditStore{backend: backend}
	stored, counter, err := backend.loadAuditEntries()
	if err != nil {
		log.Printf("load audit entries: %v", err)
		return s
	}
	if len(stored) > auditCapacity {
		stored = stored[len(stored)-auditCapacity:]
	}
	s.entries = stored
	s.counter = counter
	return s
}

func (s *auditStore) record(entry auditEntry) string {
	s.mu.Lock()
	s.counter++
	entry.ID = fmt.Sprintf("aud_%d", s.counter)
	if entry.At.IsZero() {
		entry.At = time.Now().UTC()
	}
	s.entries = append(s.entries, entry)
	if len(s.entries) > auditCapacity {
		kept := make([]auditEntry, auditCapacity)
		copy(kept, s.entries[len(s.entries)-auditCapacity:])
		s.entries = kept
	}
	s.mu.Unlock()
	if err := s.backend.appendAuditEntry(entry); err != nil {
		log.Printf("persist audit entry %s: %v", entry.ID, err)
	}
	return entry.ID
}

func (s *auditStore) list() []auditEntryView {
	s.mu.Lock()
	defer s.mu.Unlock()
	views := make([]auditEntryView, 0, len(s.entries))
	for i := len(s.entries) - 1; i >= 0; i-- {
		views = append(views, auditEntryToView(s.entries[i]))
	}
	return views
}

func handleAuditLog(audit *auditStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": audit.list()})
	}
}
