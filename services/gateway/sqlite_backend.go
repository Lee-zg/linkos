package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// sqliteBackend is the durable persistBackend. It stores the access policy,
// access records, bounded audit trail, WS event ring, and upload session
// metadata so a gateway restart restores that state. Auth sessions stay in
// memory by design: they are short-lived bearer tokens, and the access gate
// re-issues them after a restart.
type sqliteBackend struct {
	db *sql.DB
}

func newSQLiteBackend(path string) (*sqliteBackend, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// A single connection avoids SQLITE_BUSY between the gateway's own
	// writers; all persistence happens on one server process.
	db.SetMaxOpenConns(1)
	backend := &sqliteBackend{db: db}
	if err := backend.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return backend, nil
}

// sqliteMigrations is versioned DDL; each entry is applied once and tracked
// in schema_migrations. Never edit applied versions — append new ones.
var sqliteMigrations = [][]string{
	{
		`CREATE TABLE IF NOT EXISTS access_policy (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			allow_anonymous_application INTEGER NOT NULL,
			allow_full_anonymous INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS access_records (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			display_name TEXT NOT NULL,
			access_type TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			reviewed_at TEXT,
			reviewed_by TEXT,
			note TEXT,
			remote_addr TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS audit_entries (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			at TEXT NOT NULL,
			actor_user_id TEXT,
			actor_name TEXT,
			action TEXT NOT NULL,
			target TEXT,
			detail TEXT,
			remote_addr TEXT
		)`,
	},
	{
		`CREATE TABLE IF NOT EXISTS events (
			seq INTEGER PRIMARY KEY,
			v INTEGER NOT NULL,
			type TEXT NOT NULL,
			event_id TEXT NOT NULL,
			ts TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			actor_id TEXT,
			payload TEXT
		)`,
	},
	{
		`CREATE TABLE IF NOT EXISTS uploads (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			size INTEGER NOT NULL,
			mime_type TEXT NOT NULL,
			chunk_size INTEGER NOT NULL,
			total_parts INTEGER NOT NULL,
			received TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			directory TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			completed_path TEXT NOT NULL
		)`,
	},
}

func (b *sqliteBackend) migrate() error {
	if _, err := b.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`); err != nil {
		return err
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var current int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	for version, stmts := range sqliteMigrations {
		number := version + 1
		if number <= current {
			continue
		}
		for _, stmt := range stmts {
			if _, err := tx.Exec(stmt); err != nil {
				return fmt.Errorf("schema v%d: %w", number, err)
			}
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, number); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (b *sqliteBackend) loadPolicy() (policyState, bool, error) {
	row := b.db.QueryRow(`SELECT allow_anonymous_application, allow_full_anonymous FROM access_policy WHERE id = 1`)
	var allowAnonymous, allowFull int
	err := row.Scan(&allowAnonymous, &allowFull)
	if errors.Is(err, sql.ErrNoRows) {
		return policyState{}, false, nil
	}
	if err != nil {
		return policyState{}, false, err
	}
	return policyState{
		AllowAnonymousApplication: allowAnonymous != 0,
		AllowFullAnonymous:        allowFull != 0,
	}, true, nil
}

func (b *sqliteBackend) savePolicy(state policyState) error {
	_, err := b.db.Exec(`
		INSERT INTO access_policy (id, allow_anonymous_application, allow_full_anonymous)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			allow_anonymous_application = excluded.allow_anonymous_application,
			allow_full_anonymous = excluded.allow_full_anonymous`,
		boolToInt(state.AllowAnonymousApplication), boolToInt(state.AllowFullAnonymous))
	return err
}

func (b *sqliteBackend) loadAccessRecords() ([]accessRecord, int, error) {
	rows, err := b.db.Query(`
		SELECT id, user_id, display_name, access_type, status, created_at, reviewed_at, reviewed_by, note, remote_addr, seq
		FROM access_records ORDER BY seq`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var records []accessRecord
	counter := 0
	for rows.Next() {
		var record accessRecord
		var createdAt, reviewedAt, reviewedBy, note, remoteAddr sql.NullString
		var seq int
		if err := rows.Scan(&record.ID, &record.UserID, &record.DisplayName, &record.AccessType, &record.Status,
			&createdAt, &reviewedAt, &reviewedBy, &note, &remoteAddr, &seq); err != nil {
			return nil, 0, err
		}
		record.CreatedAt = parseStoredTime(createdAt.String)
		if reviewedAt.Valid {
			record.ReviewedAt = parseStoredTime(reviewedAt.String)
		}
		record.ReviewedBy = reviewedBy.String
		record.Note = note.String
		record.RemoteAddr = remoteAddr.String
		records = append(records, record)
		if seq > counter {
			counter = seq
		}
	}
	return records, counter, rows.Err()
}

func (b *sqliteBackend) appendAccessRecord(record accessRecord) error {
	_, err := b.db.Exec(`
		INSERT INTO access_records (id, user_id, display_name, access_type, status, created_at, reviewed_at, reviewed_by, note, remote_addr)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.ID, record.UserID, record.DisplayName, record.AccessType, record.Status,
		record.CreatedAt.Format(time.RFC3339), storedTime(record.ReviewedAt),
		nullString(record.ReviewedBy), nullString(record.Note), nullString(record.RemoteAddr))
	return err
}

func (b *sqliteBackend) updateAccessRecord(record accessRecord) error {
	result, err := b.db.Exec(`
		UPDATE access_records SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
		record.Status, storedTime(record.ReviewedAt), nullString(record.ReviewedBy), record.ID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("access record %s not found", record.ID)
	}
	return nil
}

func (b *sqliteBackend) loadAuditEntries() ([]auditEntry, int, error) {
	rows, err := b.db.Query(`
		SELECT id, at, actor_user_id, actor_name, action, target, detail, remote_addr, seq
		FROM audit_entries ORDER BY seq`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var entries []auditEntry
	counter := 0
	for rows.Next() {
		var entry auditEntry
		var at string
		var actorUserID, actorName, target, detail, remoteAddr sql.NullString
		var seq int
		if err := rows.Scan(&entry.ID, &at, &actorUserID, &actorName, &entry.Action, &target, &detail, &remoteAddr, &seq); err != nil {
			return nil, 0, err
		}
		entry.At = parseStoredTime(at)
		entry.ActorUserID = actorUserID.String
		entry.ActorName = actorName.String
		entry.Target = target.String
		entry.Detail = detail.String
		entry.RemoteAddr = remoteAddr.String
		entries = append(entries, entry)
		if seq > counter {
			counter = seq
		}
	}
	return entries, counter, rows.Err()
}

// appendAuditEntry inserts the entry and trims rows beyond auditCapacity so
// the durable trail stays bounded like the in-memory one.
func (b *sqliteBackend) appendAuditEntry(entry auditEntry) error {
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`
		INSERT INTO audit_entries (id, at, actor_user_id, actor_name, action, target, detail, remote_addr)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.At.Format(time.RFC3339), nullString(entry.ActorUserID), nullString(entry.ActorName),
		entry.Action, nullString(entry.Target), nullString(entry.Detail), nullString(entry.RemoteAddr)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM audit_entries WHERE seq <= (SELECT MAX(seq) - ? FROM audit_entries)`, auditCapacity); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *sqliteBackend) appendEvent(e event) error {
	payload, err := json.Marshal(e.Payload)
	if err != nil {
		return fmt.Errorf("marshal event payload: %w", err)
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`
		INSERT INTO events (seq, v, type, event_id, ts, workspace_id, actor_id, payload)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		e.Seq, e.V, e.Type, e.EventID, e.TS, e.WorkspaceID, nullString(e.ActorID), string(payload)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM events WHERE seq <= (SELECT MAX(seq) - ? FROM events)`, eventRetention); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *sqliteBackend) loadEvents() ([]event, error) {
	rows, err := b.db.Query(`
		SELECT seq, v, type, event_id, ts, workspace_id, actor_id, payload
		FROM events ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []event
	for rows.Next() {
		var e event
		var actorID sql.NullString
		var payload []byte
		if err := rows.Scan(&e.Seq, &e.V, &e.Type, &e.EventID, &e.TS, &e.WorkspaceID, &actorID, &payload); err != nil {
			return nil, err
		}
		e.ActorID = actorID.String
		if len(payload) > 0 {
			if err := json.Unmarshal(payload, &e.Payload); err != nil {
				return nil, fmt.Errorf("unmarshal event %d payload: %w", e.Seq, err)
			}
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// saveUploadSession upserts the session snapshot; the received map is stored
// as a JSON object keyed by part number.
func (b *sqliteBackend) saveUploadSession(session uploadSession) error {
	received, err := json.Marshal(session.received)
	if err != nil {
		return fmt.Errorf("marshal received parts: %w", err)
	}
	_, err = b.db.Exec(`
		INSERT INTO uploads (id, name, size, mime_type, chunk_size, total_parts, received, content_hash, status, directory, resource_id, completed_path)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			size = excluded.size,
			mime_type = excluded.mime_type,
			chunk_size = excluded.chunk_size,
			total_parts = excluded.total_parts,
			received = excluded.received,
			content_hash = excluded.content_hash,
			status = excluded.status,
			directory = excluded.directory,
			resource_id = excluded.resource_id,
			completed_path = excluded.completed_path`,
		session.id, session.name, session.size, session.mimeType, session.chunkSize, session.totalParts,
		string(received), session.contentHash, session.status, session.directory, session.resourceID, session.completedPath)
	return err
}

func (b *sqliteBackend) loadUploadSessions() ([]uploadSession, error) {
	rows, err := b.db.Query(`
		SELECT id, name, size, mime_type, chunk_size, total_parts, received, content_hash, status, directory, resource_id, completed_path
		FROM uploads ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessions []uploadSession
	for rows.Next() {
		var session uploadSession
		var received []byte
		if err := rows.Scan(&session.id, &session.name, &session.size, &session.mimeType, &session.chunkSize,
			&session.totalParts, &received, &session.contentHash, &session.status, &session.directory,
			&session.resourceID, &session.completedPath); err != nil {
			return nil, err
		}
		session.received = make(map[int]int64)
		if len(received) > 0 {
			if err := json.Unmarshal(received, &session.received); err != nil {
				return nil, fmt.Errorf("unmarshal received parts of %s: %w", session.id, err)
			}
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (b *sqliteBackend) backupTo(dir string) (backupManifest, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return backupManifest{}, err
	}
	name := fmt.Sprintf("gateway-%s.db", time.Now().UTC().Format("20060102-150405.000"))
	path := filepath.Join(dir, name)
	// VACUUM INTO snapshots a consistent database image even with live
	// writers in WAL mode.
	if _, err := b.db.Exec(`VACUUM INTO ?`, path); err != nil {
		return backupManifest{}, fmt.Errorf("vacuum into %s: %w", path, err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return backupManifest{}, fmt.Errorf("read snapshot %s: %w", path, err)
	}
	version, err := snapshotSchemaVersion(path)
	if err != nil {
		return backupManifest{}, err
	}
	sum := sha256.Sum256(content)
	return backupManifest{
		File:          name,
		Path:          path,
		Size:          int64(len(content)),
		SHA256:        hex.EncodeToString(sum[:]),
		CreatedAt:     time.Now().UTC(),
		SchemaVersion: version,
	}, nil
}

func snapshotSchemaVersion(path string) (int, error) {
	snapshot, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", path))
	if err != nil {
		return 0, err
	}
	defer snapshot.Close()
	var version int
	if err := snapshot.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read snapshot schema version: %w", err)
	}
	return version, nil
}

func (b *sqliteBackend) Close() error { return b.db.Close() }

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func storedTime(value time.Time) sql.NullString {
	if value.IsZero() {
		return sql.NullString{}
	}
	return sql.NullString{String: value.Format(time.RFC3339), Valid: true}
}

func parseStoredTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
