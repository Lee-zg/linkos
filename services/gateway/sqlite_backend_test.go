package main

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func testSQLitePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "gateway.db")
}

func newTestSQLiteBackend(t *testing.T, path string) *sqliteBackend {
	t.Helper()
	if path == "" {
		path = testSQLitePath(t)
	}
	backend, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("open sqlite backend: %v", err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func TestSQLitePolicyRoundTrip(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)

	if _, ok, err := backend.loadPolicy(); err != nil || ok {
		t.Fatalf("fresh backend must have no policy, ok=%t err=%v", ok, err)
	}
	if err := backend.savePolicy(policyState{AllowAnonymousApplication: true, AllowFullAnonymous: false}); err != nil {
		t.Fatalf("savePolicy: %v", err)
	}
	if err := backend.savePolicy(policyState{AllowAnonymousApplication: false, AllowFullAnonymous: true}); err != nil {
		t.Fatalf("savePolicy overwrite: %v", err)
	}
	state, ok, err := backend.loadPolicy()
	if err != nil || !ok {
		t.Fatalf("loadPolicy after save: ok=%t err=%v", ok, err)
	}
	if state.AllowAnonymousApplication || !state.AllowFullAnonymous {
		t.Fatalf("policy must reflect last save, got %+v", state)
	}

	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()
	state, ok, err = reopened.loadPolicy()
	if err != nil || !ok || state.AllowAnonymousApplication || !state.AllowFullAnonymous {
		t.Fatalf("policy must survive restart, got %+v ok=%t err=%v", state, ok, err)
	}
}

func TestSQLiteAccessRecordsRoundTrip(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	now := time.Now().UTC().Truncate(time.Second)

	first := accessRecord{
		ID:          "acc_1",
		UserID:      "usr_alice",
		DisplayName: "Alice",
		AccessType:  accessTypeLogin,
		Status:      accessStatusActive,
		CreatedAt:   now,
		RemoteAddr:  "10.0.0.1:50000",
	}
	second := accessRecord{
		ID:          "acc_2",
		UserID:      "usr_bob",
		DisplayName: "Bob",
		AccessType:  accessTypeAnonymous,
		Status:      accessStatusPending,
		CreatedAt:   now.Add(time.Second),
		Note:        "please approve",
		RemoteAddr:  "10.0.0.2:50001",
	}
	if err := backend.appendAccessRecord(first); err != nil {
		t.Fatalf("append first: %v", err)
	}
	if err := backend.appendAccessRecord(second); err != nil {
		t.Fatalf("append second: %v", err)
	}

	records, counter, err := backend.loadAccessRecords()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if counter != 2 {
		t.Fatalf("counter must equal highest seq, got %d", counter)
	}
	if len(records) != 2 || records[0].ID != "acc_1" || records[1].ID != "acc_2" {
		t.Fatalf("records must load in insertion order, got %+v", records)
	}
	if !records[0].CreatedAt.Equal(now) || records[0].RemoteAddr != "10.0.0.1:50000" {
		t.Fatalf("first record fields must round-trip, got %+v", records[0])
	}
	if records[1].Note != "please approve" || !records[1].ReviewedAt.IsZero() {
		t.Fatalf("second record fields must round-trip, got %+v", records[1])
	}

	second.Status = accessStatusRejected
	second.ReviewedAt = now.Add(2 * time.Second)
	second.ReviewedBy = "usr_admin"
	if err := backend.updateAccessRecord(second); err != nil {
		t.Fatalf("update: %v", err)
	}

	records, counter, err = backend.loadAccessRecords()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if counter != 2 {
		t.Fatalf("update must not advance counter, got %d", counter)
	}
	if records[1].Status != accessStatusRejected || records[1].ReviewedBy != "usr_admin" || !records[1].ReviewedAt.Equal(now.Add(2*time.Second)) {
		t.Fatalf("updated fields must round-trip, got %+v", records[1])
	}

	if err := backend.updateAccessRecord(accessRecord{ID: "acc_missing", Status: accessStatusActive}); err == nil {
		t.Fatal("updating an unknown record must fail")
	}
}

func TestSQLiteAuditBoundAndCounter(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	total := auditCapacity + 5
	for i := 1; i <= total; i++ {
		entry := auditEntry{
			ID:     fmt.Sprintf("aud_%d", i),
			At:     time.Now().UTC().Truncate(time.Second),
			Action: auditActionSessionIssue,
			Detail: fmt.Sprintf("%d", i),
		}
		if err := backend.appendAuditEntry(entry); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	entries, counter, err := backend.loadAuditEntries()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if counter != total {
		t.Fatalf("counter must keep full sequence, got %d want %d", counter, total)
	}
	if len(entries) != auditCapacity {
		t.Fatalf("audit table must stay bounded at %d, got %d", auditCapacity, len(entries))
	}
	if entries[0].ID != "aud_6" || entries[len(entries)-1].ID != fmt.Sprintf("aud_%d", total) {
		t.Fatalf("oldest entries beyond capacity must be trimmed, got first=%s last=%s", entries[0].ID, entries[len(entries)-1].ID)
	}
}

func TestSQLiteMigrationIdempotent(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)
	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("migrations must be safe to re-run: %v", err)
	}
	defer reopened.Close()
	if err := reopened.appendAuditEntry(auditEntry{ID: "aud_1", At: time.Now().UTC(), Action: auditActionSessionIssue}); err != nil {
		t.Fatalf("write after re-migration: %v", err)
	}
}

func TestStoresRestoreFromSQLite(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)

	policy := newAccessPolicyWithBackend(backend)
	policy.set(true, false)

	records := newAccessStoreWithBackend(backend)
	first := records.add(&accessRecord{
		UserID:      "usr_alice",
		DisplayName: "Alice",
		AccessType:  accessTypeLogin,
		Status:      accessStatusActive,
		CreatedAt:   time.Now().UTC().Truncate(time.Second),
	})
	second := records.add(&accessRecord{
		UserID:      "usr_bob",
		DisplayName: "Bob",
		AccessType:  accessTypeAnonymous,
		Status:      accessStatusPending,
		CreatedAt:   time.Now().UTC().Truncate(time.Second),
		Note:        "please approve",
	})
	if _, ok := records.review(second, accessStatusActive, "admin"); !ok {
		t.Fatal("review of pending record must succeed")
	}

	audit := newAuditStoreWithBackend(backend)
	audit.record(auditEntry{ActorName: "Alice", Action: auditActionSessionIssue, Target: first})
	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()

	restoredPolicy := newAccessPolicyWithBackend(reopened)
	if allowAnonymous, allowFull := restoredPolicy.get(); !allowAnonymous || allowFull {
		t.Fatalf("policy must survive restart, got anonymous=%t full=%t", allowAnonymous, allowFull)
	}

	restoredRecords := newAccessStoreWithBackend(reopened)
	views := restoredRecords.list()
	if len(views) != 2 {
		t.Fatalf("expected 2 restored records, got %d", len(views))
	}
	if views[0].ID != second || views[0].Status != accessStatusActive || views[0].ReviewedBy != "admin" {
		t.Fatalf("reviewed record must survive restart with its decision, got %+v", views[0])
	}
	if views[1].ID != first || views[1].DisplayName != "Alice" {
		t.Fatalf("first record must survive restart, got %+v", views[1])
	}
	if next := restoredRecords.add(&accessRecord{UserID: "usr_carol", DisplayName: "Carol", AccessType: accessTypeLogin, Status: accessStatusActive, CreatedAt: time.Now().UTC()}); next != "acc_3" {
		t.Fatalf("record ID sequence must continue after restart, got %s", next)
	}

	restoredAudit := newAuditStoreWithBackend(reopened)
	entries := restoredAudit.list()
	if len(entries) != 1 || entries[0].Action != auditActionSessionIssue || entries[0].Target != first {
		t.Fatalf("audit entries must survive restart, got %+v", entries)
	}
	if nextID := restoredAudit.record(auditEntry{Action: auditActionPolicyUpdate}); nextID != "aud_2" {
		t.Fatalf("audit ID sequence must continue after restart, got %s", nextID)
	}
}

func TestSQLiteEventsRoundTrip(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)

	posted := []event{
		{V: 1, Type: "chat.message.created", EventID: "evt_1", Seq: 1, TS: "2026-09-01T00:00:00Z", WorkspaceID: "demo", ActorID: "gateway", Payload: map[string]interface{}{"body": "hello"}},
		{V: 1, Type: "job.status.changed", EventID: "evt_2", Seq: 2, TS: "2026-09-01T00:00:01Z", WorkspaceID: "demo", ActorID: "gateway", Payload: map[string]interface{}{"jobId": "job_1", "status": "running"}},
		{V: 1, Type: "test.empty", EventID: "evt_3", Seq: 3, TS: "2026-09-01T00:00:02Z", WorkspaceID: "demo", ActorID: "gateway"},
	}
	for _, e := range posted {
		if err := backend.appendEvent(e); err != nil {
			t.Fatalf("append %s: %v", e.EventID, err)
		}
	}

	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()

	events, err := reopened.loadEvents()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events after restart, got %d", len(events))
	}
	for i, want := range posted {
		got := events[i]
		if got.Seq != want.Seq || got.Type != want.Type || got.EventID != want.EventID || got.TS != want.TS || got.WorkspaceID != want.WorkspaceID || got.ActorID != want.ActorID {
			t.Fatalf("event %d envelope must round-trip, got %+v want %+v", i, got, want)
		}
	}
	firstPayload, ok := events[0].Payload.(map[string]interface{})
	if !ok || firstPayload["body"] != "hello" {
		t.Fatalf("event payload must round-trip through JSON, got %#v", events[0].Payload)
	}
	if events[2].Payload != nil {
		t.Fatalf("nil payload must round-trip as nil, got %#v", events[2].Payload)
	}
}

func TestSQLiteEventsBound(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	total := int64(eventRetention + 5)
	for i := int64(1); i <= total; i++ {
		entry := event{V: 1, Type: "test.bound", EventID: fmt.Sprintf("evt_%d", i), Seq: i, TS: "2026-09-01T00:00:00Z", WorkspaceID: "demo", ActorID: "gateway"}
		if err := backend.appendEvent(entry); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	events, err := backend.loadEvents()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(events) != eventRetention {
		t.Fatalf("event table must stay bounded at %d, got %d", eventRetention, len(events))
	}
	if events[0].Seq != 6 || events[len(events)-1].Seq != total {
		t.Fatalf("oldest events beyond retention must be trimmed, got first=%d last=%d", events[0].Seq, events[len(events)-1].Seq)
	}
}

func TestEventStoreRestoresFromSQLite(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)

	store := newMemoryEventStoreWithBackend(eventRetention, backend)
	store.Append("chat.message.created", map[string]string{"body": "before restart"})
	store.Append("chat.message.created", map[string]string{"body": "still here"})
	lastSeq := store.CurrentSeq()
	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()

	restored := newMemoryEventStoreWithBackend(eventRetention, reopened)
	if restored.CurrentSeq() != lastSeq {
		t.Fatalf("seq must resume from %d after restart, got %d", lastSeq, restored.CurrentSeq())
	}
	events, complete := restored.Since(0)
	if !complete || len(events) != 2 {
		t.Fatalf("replay within retention must be complete after restart, complete=%v events=%d", complete, len(events))
	}
	if payload, ok := events[0].Payload.(map[string]interface{}); !ok || payload["body"] != "before restart" {
		t.Fatalf("replayed payload must survive restart, got %#v", events[0].Payload)
	}
	next := restored.Append("chat.message.created", map[string]string{"body": "after restart"})
	if next.Seq != lastSeq+1 {
		t.Fatalf("new events must continue the sequence, got seq %d want %d", next.Seq, lastSeq+1)
	}
}

func TestSQLiteUploadSessionRoundTrip(t *testing.T) {
	path := testSQLitePath(t)
	backend := newTestSQLiteBackend(t, path)

	session := uploadSession{
		id:          "up_1",
		name:        "artifact.bin",
		size:        16,
		mimeType:    "application/octet-stream",
		chunkSize:   5,
		totalParts:  4,
		received:    map[int]int64{0: 5, 2: 5},
		status:      "uploading",
		directory:   filepath.Join("root", "up_1"),
		contentHash: "ab12",
	}
	if err := backend.saveUploadSession(session); err != nil {
		t.Fatalf("save: %v", err)
	}

	session.status = "completed"
	session.resourceID = "file_up_1"
	session.completedPath = filepath.Join("root", "up_1", "complete")
	session.received[1] = 5
	session.received[3] = 1
	if err := backend.saveUploadSession(session); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	sessions, err := backend.loadUploadSessions()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("upsert must not duplicate rows, got %d sessions", len(sessions))
	}
	got := sessions[0]
	if got.id != "up_1" || got.name != "artifact.bin" || got.size != 16 || got.chunkSize != 5 || got.totalParts != 4 {
		t.Fatalf("session fields must round-trip, got %+v", got)
	}
	if got.status != "completed" || got.resourceID != "file_up_1" || got.completedPath == "" {
		t.Fatalf("updated fields must round-trip, got %+v", got)
	}
	if len(got.received) != 4 || got.received[0] != 5 || got.received[3] != 1 {
		t.Fatalf("received parts map must round-trip, got %+v", got.received)
	}

	if err := backend.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()
	sessions, err = reopened.loadUploadSessions()
	if err != nil || len(sessions) != 1 || sessions[0].status != "completed" {
		t.Fatalf("upload session must survive restart, sessions=%+v err=%v", sessions, err)
	}
}
