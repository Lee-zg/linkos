package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// persistBackend is the storage seam for R-02. In-memory stores stay the
// request-path source of truth; a backend mirrors durable state (access
// policy, access records, audit trail, WS events, upload sessions) so a
// gateway restart can restore it. The memory backend keeps the previous
// no-persistence behavior as default and as a test double.
type persistBackend interface {
	loadPolicy() (policyState, bool, error)
	savePolicy(policyState) error
	loadAccessRecords() ([]accessRecord, int, error)
	appendAccessRecord(accessRecord) error
	updateAccessRecord(accessRecord) error
	loadAuditEntries() ([]auditEntry, int, error)
	appendAuditEntry(auditEntry) error
	loadEvents() ([]event, error)
	appendEvent(event) error
	loadUploadSessions() ([]uploadSession, error)
	saveUploadSession(uploadSession) error
	backupTo(dir string) (backupManifest, error)
	Close() error
}

// backupManifest describes one durable snapshot produced by backupTo.
type backupManifest struct {
	File          string    `json:"file"`
	Path          string    `json:"path"`
	Size          int64     `json:"size"`
	SHA256        string    `json:"sha256"`
	CreatedAt     time.Time `json:"createdAt"`
	SchemaVersion int       `json:"schemaVersion"`
}

type policyState struct {
	AllowAnonymousApplication bool
	AllowFullAnonymous        bool
}

type memoryBackend struct{}

func (memoryBackend) loadPolicy() (policyState, bool, error) { return policyState{}, false, nil }
func (memoryBackend) savePolicy(policyState) error           { return nil }
func (memoryBackend) loadAccessRecords() ([]accessRecord, int, error) {
	return nil, 0, nil
}
func (memoryBackend) appendAccessRecord(accessRecord) error { return nil }
func (memoryBackend) updateAccessRecord(accessRecord) error { return nil }
func (memoryBackend) loadAuditEntries() ([]auditEntry, int, error) {
	return nil, 0, nil
}
func (memoryBackend) appendAuditEntry(auditEntry) error { return nil }
func (memoryBackend) loadEvents() ([]event, error)      { return nil, nil }
func (memoryBackend) appendEvent(event) error           { return nil }
func (memoryBackend) loadUploadSessions() ([]uploadSession, error) {
	return nil, nil
}
func (memoryBackend) saveUploadSession(uploadSession) error { return nil }
func (memoryBackend) backupTo(string) (backupManifest, error) {
	return backupManifest{}, errors.New("memory backend has no durable state to back up")
}
func (memoryBackend) Close() error { return nil }

// openBackend selects the persistence backend from LINKOS_DATA_DIR. Unset
// keeps the memory-only default; a directory path enables SQLite at
// <dir>/gateway.db with schema migrations applied.
func openBackend() persistBackend {
	dir := strings.TrimSpace(os.Getenv("LINKOS_DATA_DIR"))
	if dir == "" {
		log.Printf("gateway storage: memory (set LINKOS_DATA_DIR to persist access state)")
		return memoryBackend{}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("create data directory %s: %v", dir, err)
	}
	path := filepath.Join(dir, "gateway.db")
	backend, err := newSQLiteBackend(path)
	if err != nil {
		log.Fatalf("open sqlite store at %s: %v", path, err)
	}
	log.Printf("gateway storage: sqlite (%s)", path)
	return backend
}
