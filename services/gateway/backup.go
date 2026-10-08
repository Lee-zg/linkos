package main

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// restoreBackup replaces <dataDir>/gateway.db with a validated backup file.
// The gateway must be stopped first: in-memory stores are the request-path
// source of truth, so restoring underneath a running server would diverge
// from its state. The previous database is stashed and rolled back if the
// install step fails.
func restoreBackup(dataDir, backupPath string) error {
	if err := validateBackupFile(backupPath); err != nil {
		return err
	}
	target := filepath.Join(dataDir, "gateway.db")
	tmp := target + ".restore-tmp"
	if err := copyFile(backupPath, tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("stage backup: %w", err)
	}
	stashed := target + ".old"
	_ = os.Remove(stashed)
	targetExisted := true
	if err := os.Rename(target, stashed); err != nil {
		if !os.IsNotExist(err) {
			_ = os.Remove(tmp)
			return fmt.Errorf("stash current database: %w", err)
		}
		targetExisted = false
	}
	if err := os.Rename(tmp, target); err != nil {
		if targetExisted {
			_ = os.Rename(stashed, target)
		}
		return fmt.Errorf("install backup: %w", err)
	}
	_ = os.Remove(stashed)
	// Stale WAL/SHM sidecars from an unclean shutdown must not shadow the
	// restored database image.
	_ = os.Remove(target + "-wal")
	_ = os.Remove(target + "-shm")
	return nil
}

func validateBackupFile(backupPath string) error {
	info, err := os.Stat(backupPath)
	if err != nil {
		return fmt.Errorf("backup file: %w", err)
	}
	if info.IsDir() || info.Size() == 0 {
		return fmt.Errorf("backup file %s is empty or not a regular file", backupPath)
	}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", backupPath))
	if err != nil {
		return fmt.Errorf("open backup: %w", err)
	}
	defer db.Close()
	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return fmt.Errorf("backup is not a usable SQLite database: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("backup failed integrity check: %s", integrity)
	}
	var version int
	if err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&version); err != nil {
		return fmt.Errorf("backup lacks the gateway schema: %w", err)
	}
	if version < 1 {
		return fmt.Errorf("backup schema version %d is not a gateway database", version)
	}
	if version > len(sqliteMigrations) {
		return fmt.Errorf("backup schema %d is newer than supported %d", version, len(sqliteMigrations))
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
