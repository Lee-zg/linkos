package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteBackupCreatesConsistentSnapshot(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	now := time.Now().UTC().Truncate(time.Second)

	if err := backend.savePolicy(policyState{AllowAnonymousApplication: true}); err != nil {
		t.Fatalf("savePolicy: %v", err)
	}
	if err := backend.appendAccessRecord(accessRecord{
		ID: "acc_1", UserID: "usr_alice", DisplayName: "Alice",
		AccessType: accessTypeLogin, Status: accessStatusActive, CreatedAt: now,
	}); err != nil {
		t.Fatalf("appendAccessRecord: %v", err)
	}
	if err := backend.appendAuditEntry(auditEntry{ID: "aud_1", At: now, Action: "test.action"}); err != nil {
		t.Fatalf("appendAuditEntry: %v", err)
	}
	if err := backend.appendEvent(event{
		Seq: 1, V: 1, Type: "test.one", EventID: "evt_1",
		TS: now.Format(time.RFC3339), WorkspaceID: "demo",
	}); err != nil {
		t.Fatalf("appendEvent: %v", err)
	}
	if err := backend.saveUploadSession(uploadSession{
		id: "up_1", name: "a.bin", status: "uploading",
		received: map[int]int64{0: 5}, directory: filepath.Join(os.TempDir(), "up_1"),
	}); err != nil {
		t.Fatalf("saveUploadSession: %v", err)
	}

	manifest, err := backend.backupTo(t.TempDir())
	if err != nil {
		t.Fatalf("backupTo: %v", err)
	}
	content, err := os.ReadFile(manifest.Path)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if manifest.Size != int64(len(content)) || manifest.Size == 0 {
		t.Fatalf("manifest size %d does not match snapshot %d", manifest.Size, len(content))
	}
	sum := sha256.Sum256(content)
	if manifest.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("manifest sha256 %s does not match snapshot", manifest.SHA256)
	}
	if manifest.SchemaVersion != len(sqliteMigrations) {
		t.Fatalf("snapshot schema version %d, want %d", manifest.SchemaVersion, len(sqliteMigrations))
	}

	snapshot := newTestSQLiteBackend(t, manifest.Path)
	state, ok, err := snapshot.loadPolicy()
	if err != nil || !ok || !state.AllowAnonymousApplication {
		t.Fatalf("snapshot policy mismatch: %+v ok=%t err=%v", state, ok, err)
	}
	records, counter, err := snapshot.loadAccessRecords()
	if err != nil || counter != 1 || len(records) != 1 || records[0].ID != "acc_1" {
		t.Fatalf("snapshot access records mismatch: %#v counter=%d err=%v", records, counter, err)
	}
	entries, _, err := snapshot.loadAuditEntries()
	if err != nil || len(entries) != 1 || entries[0].ID != "aud_1" {
		t.Fatalf("snapshot audit mismatch: %#v err=%v", entries, err)
	}
	events, err := snapshot.loadEvents()
	if err != nil || len(events) != 1 || events[0].Seq != 1 {
		t.Fatalf("snapshot events mismatch: %#v err=%v", events, err)
	}
	uploads, err := snapshot.loadUploadSessions()
	if err != nil || len(uploads) != 1 || uploads[0].id != "up_1" || uploads[0].received[0] != 5 {
		t.Fatalf("snapshot uploads mismatch: %#v err=%v", uploads, err)
	}

	// The live database must remain writable after the snapshot.
	if err := backend.savePolicy(policyState{AllowFullAnonymous: true}); err != nil {
		t.Fatalf("live database not writable after backup: %v", err)
	}
}

func TestMemoryBackendBackupUnsupported(t *testing.T) {
	if _, err := (memoryBackend{}).backupTo(t.TempDir()); err == nil {
		t.Fatal("memory backend must reject backups")
	}
}

func TestRestoreBackupRecoversPriorState(t *testing.T) {
	dataDir := t.TempDir()
	dbPath := filepath.Join(dataDir, "gateway.db")

	seed := newTestSQLiteBackend(t, dbPath)
	if err := seed.savePolicy(policyState{AllowAnonymousApplication: true}); err != nil {
		t.Fatalf("seed policy: %v", err)
	}
	manifest, err := seed.backupTo(t.TempDir())
	if err != nil {
		t.Fatalf("backupTo: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed: %v", err)
	}

	mutated := newTestSQLiteBackend(t, dbPath)
	if err := mutated.savePolicy(policyState{AllowFullAnonymous: true}); err != nil {
		t.Fatalf("mutate policy: %v", err)
	}
	if err := mutated.Close(); err != nil {
		t.Fatalf("close mutated: %v", err)
	}

	if err := restoreBackup(dataDir, manifest.Path); err != nil {
		t.Fatalf("restoreBackup: %v", err)
	}

	restored := newTestSQLiteBackend(t, dbPath)
	state, ok, err := restored.loadPolicy()
	if err != nil || !ok || !state.AllowAnonymousApplication || state.AllowFullAnonymous {
		t.Fatalf("restored policy must match backup point: %+v ok=%t err=%v", state, ok, err)
	}
}

func TestRestoreRejectsInvalidBackup(t *testing.T) {
	dataDir := t.TempDir()
	dbPath := filepath.Join(dataDir, "gateway.db")
	seed := newTestSQLiteBackend(t, dbPath)
	if err := seed.savePolicy(policyState{AllowAnonymousApplication: true}); err != nil {
		t.Fatalf("seed policy: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed: %v", err)
	}

	badPath := filepath.Join(t.TempDir(), "bad.db")
	if err := os.WriteFile(badPath, []byte("not a sqlite database"), 0o644); err != nil {
		t.Fatalf("write bad backup: %v", err)
	}
	if err := restoreBackup(dataDir, badPath); err == nil {
		t.Fatal("restore must reject a non-SQLite file")
	}
	if err := restoreBackup(dataDir, filepath.Join(t.TempDir(), "missing.db")); err == nil {
		t.Fatal("restore must reject a missing file")
	}

	survivor := newTestSQLiteBackend(t, dbPath)
	state, ok, err := survivor.loadPolicy()
	if err != nil || !ok || !state.AllowAnonymousApplication {
		t.Fatalf("failed restore must leave the original database intact: %+v ok=%t err=%v", state, ok, err)
	}
}

func TestBackupManifestNamesSnapshotFile(t *testing.T) {
	backend := newTestSQLiteBackend(t, "")
	dir := t.TempDir()
	manifest, err := backend.backupTo(dir)
	if err != nil {
		t.Fatalf("backupTo: %v", err)
	}
	if filepath.Dir(manifest.Path) != filepath.Clean(dir) || manifest.File == "" || manifest.CreatedAt.IsZero() {
		t.Fatalf("manifest fields incomplete: %#v", manifest)
	}
	file, err := os.Open(manifest.Path)
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer file.Close()
	head := make([]byte, 16)
	if _, err := io.ReadFull(file, head); err != nil {
		t.Fatalf("read snapshot header: %v", err)
	}
	if !bytes.HasPrefix(head, []byte("SQLite format 3")) {
		t.Fatalf("snapshot is not a SQLite database, header %q", head)
	}
}
