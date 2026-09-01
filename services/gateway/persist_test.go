package main

import "testing"

func TestMemoryBackendPersistsNothing(t *testing.T) {
	var backend persistBackend = memoryBackend{}

	state, ok, err := backend.loadPolicy()
	if err != nil {
		t.Fatalf("loadPolicy error: %v", err)
	}
	if ok || state.AllowAnonymousApplication || state.AllowFullAnonymous {
		t.Fatalf("memory backend must report no stored policy, got %+v ok=%t", state, ok)
	}
	if err := backend.savePolicy(policyState{AllowAnonymousApplication: true, AllowFullAnonymous: true}); err != nil {
		t.Fatalf("savePolicy error: %v", err)
	}
	if _, ok, _ := backend.loadPolicy(); ok {
		t.Fatal("memory backend must not persist policy")
	}

	if err := backend.appendAccessRecord(accessRecord{ID: "acc_1"}); err != nil {
		t.Fatalf("appendAccessRecord error: %v", err)
	}
	if err := backend.updateAccessRecord(accessRecord{ID: "acc_1"}); err != nil {
		t.Fatalf("updateAccessRecord error: %v", err)
	}
	records, counter, err := backend.loadAccessRecords()
	if err != nil {
		t.Fatalf("loadAccessRecords error: %v", err)
	}
	if len(records) != 0 || counter != 0 {
		t.Fatalf("memory backend must not persist records, got %d records counter=%d", len(records), counter)
	}

	if err := backend.appendAuditEntry(auditEntry{ID: "aud_1", Action: auditActionSessionIssue}); err != nil {
		t.Fatalf("appendAuditEntry error: %v", err)
	}
	entries, counter, err := backend.loadAuditEntries()
	if err != nil {
		t.Fatalf("loadAuditEntries error: %v", err)
	}
	if len(entries) != 0 || counter != 0 {
		t.Fatalf("memory backend must not persist audit entries, got %d entries counter=%d", len(entries), counter)
	}

	if err := backend.appendEvent(event{Seq: 1, Type: "test.one"}); err != nil {
		t.Fatalf("appendEvent error: %v", err)
	}
	events, err := backend.loadEvents()
	if err != nil {
		t.Fatalf("loadEvents error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("memory backend must not persist events, got %d events", len(events))
	}

	if err := backend.saveUploadSession(uploadSession{id: "up_1", name: "a.bin", status: "created"}); err != nil {
		t.Fatalf("saveUploadSession error: %v", err)
	}
	sessions, err := backend.loadUploadSessions()
	if err != nil {
		t.Fatalf("loadUploadSessions error: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("memory backend must not persist upload sessions, got %d sessions", len(sessions))
	}

	if err := backend.Close(); err != nil {
		t.Fatalf("Close error: %v", err)
	}
}

func TestStoreConstructorsDefaultToMemoryBackend(t *testing.T) {
	policy := newAccessPolicy()
	policy.set(true, true)
	records := newAccessStore()
	id := records.add(&accessRecord{UserID: "usr_a", DisplayName: "A", Status: accessStatusPending})
	audit := newAuditStore()
	audit.record(auditEntry{Action: auditActionSessionIssue})

	rebuiltPolicy := newAccessPolicy()
	if allowAnonymous, allowFull := rebuiltPolicy.get(); allowAnonymous || allowFull {
		t.Fatal("memory backend must not carry policy across store instances")
	}
	rebuiltRecords := newAccessStore()
	if views := rebuiltRecords.list(); len(views) != 0 {
		t.Fatalf("memory backend must not carry records across store instances, got %d", len(views))
	}
	if got := rebuiltRecords.add(&accessRecord{UserID: "usr_b", DisplayName: "B", Status: accessStatusPending}); got != "acc_1" {
		t.Fatalf("memory record IDs must restart per instance, got %s (leak from %s)", got, id)
	}
	rebuiltAudit := newAuditStore()
	if entries := rebuiltAudit.list(); len(entries) != 0 {
		t.Fatalf("memory backend must not carry audit entries across store instances, got %d", len(entries))
	}
}
