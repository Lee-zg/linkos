package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type workspaceFile struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type workspaceManifest struct {
	Format     int                      `json:"format"`
	Version    string                   `json:"version"`
	Schema     int                      `json:"databaseSchema"`
	CreatedAt  time.Time                `json:"createdAt"`
	UploadRoot string                   `json:"uploadRoot"`
	Files      map[string]workspaceFile `json:"files"`
}

func sqliteReadOnly(file string) (*sql.DB, error) {
	u := url.URL{Path: filepath.ToSlash(file)}
	return sql.Open("sqlite", "file:"+u.EscapedPath()+"?mode=ro")
}
func databaseVersion(file string) (int, error) {
	db, e := sqliteReadOnly(file)
	if e != nil {
		return 0, e
	}
	defer db.Close()
	var v int
	e = db.QueryRow("SELECT COALESCE(MAX(version),0) FROM schema_migrations").Scan(&v)
	return v, e
}

// Called while holding the workspace lock, before migration can change a byte.
func prepareMigrationBackup(home string, c runtimeConfig) error {
	file := filepath.Join(c.DataDir, "gateway.db")
	if _, e := os.Stat(file); os.IsNotExist(e) {
		return nil
	}
	v, e := databaseVersion(file)
	if e != nil {
		return e
	}
	if v > len(sqliteMigrations) {
		return fmt.Errorf("database schema %d is newer than supported %d; restore a compatible full backup before rollback", v, len(sqliteMigrations))
	}
	var previous struct {
		Version string `json:"version"`
	}
	if raw, err := os.ReadFile(filepath.Join(c.DataDir, "runtime-version.json")); err == nil {
		_ = json.Unmarshal(raw, &previous)
	}
	if v < len(sqliteMigrations) || previous.Version != buildVersion {
		return backupWorkspace(home, filepath.Join(home, "linkos.json"), c, filepath.Join(home, "backups", "before-migration-"+time.Now().UTC().Format("20060102T150405.000000000")+".tar.gz"))
	}
	return nil
}

func backupWorkspace(home, configFile string, c runtimeConfig, output string) error {
	if _, e := os.Stat(output); e == nil {
		return errors.New("backup output already exists")
	}
	stage, e := os.MkdirTemp("", "linkos-backup-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stage)
	db, e := sqliteReadOnly(filepath.Join(c.DataDir, "gateway.db"))
	if e != nil {
		return e
	}
	snapshot := filepath.Join(stage, "gateway.db")
	_, e = db.Exec("VACUUM INTO '" + strings.ReplaceAll(filepath.ToSlash(snapshot), "'", "''") + "'")
	db.Close()
	if e != nil {
		return fmt.Errorf("database snapshot: %w", e)
	}
	if e = validateBackupFile(snapshot); e != nil {
		return e
	}
	schema, e := databaseVersion(snapshot)
	if e != nil {
		return e
	}
	sources := map[string]string{"data/gateway.db": snapshot}
	// Save effective configuration; command-line/env values may differ from disk.
	config := filepath.Join(stage, "linkos.json")
	if e = writePrivateJSON(config, c); e != nil {
		return e
	}
	sources["linkos.json"] = config
	addTree := func(root, prefix string, skip func(string) bool) error {
		if _, e := os.Stat(root); os.IsNotExist(e) {
			return nil
		}
		return filepath.WalkDir(root, func(file string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, e := filepath.Rel(root, file)
			if e != nil {
				return e
			}
			if skip != nil && skip(file) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("backup refuses symlink: %s", file)
			}
			if d.IsDir() {
				return nil
			}
			info, e := d.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("unsupported file: %s", file)
			}
			sources[path.Join(prefix, filepath.ToSlash(rel))] = file
			return nil
		})
	}
	if e = addTree(c.DataDir, "data", func(file string) bool {
		return file == c.UploadDir || (c.PluginDir != "" && file == c.PluginDir) || file == filepath.Join(c.DataDir, "backups") || strings.HasPrefix(filepath.Base(file), "gateway.db") || file == output

	}); e != nil {
		return e
	}
	if e = addTree(c.UploadDir, "uploads", nil); e != nil {
		return e
	}
	if e = addTree(filepath.Join(home, "tls"), "tls", nil); e != nil {
		return e
	}
	if c.TLSCertFile != "" {
		sources["tls/server.crt"] = c.TLSCertFile
		sources["tls/server.key"] = c.TLSKeyFile
	}
	if c.PluginDir != "" {
		if e = addTree(c.PluginDir, "plugins", nil); e != nil {
			return e
		}
	}
	manifest := workspaceManifest{Format: 1, Version: buildVersion, Schema: schema, CreatedAt: time.Now().UTC(), UploadRoot: c.UploadDir, Files: map[string]workspaceFile{}}
	names := []string{}
	for name, file := range sources {
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		h := sha256.New()
		size, e := io.Copy(h, f)
		f.Close()
		if e != nil {
			return e
		}
		manifest.Files[name] = workspaceFile{size, hex.EncodeToString(h.Sum(nil))}
		names = append(names, name)
	}
	sort.Strings(names)
	if e = os.MkdirAll(filepath.Dir(output), 0700); e != nil {
		return e
	}
	out, e := os.CreateTemp(filepath.Dir(output), ".backup-*")
	if e != nil {
		return e
	}
	temp := out.Name()
	defer os.Remove(temp)
	out.Chmod(0600)
	zip := gzip.NewWriter(out)
	archive := tar.NewWriter(zip)
	raw, _ := json.Marshal(manifest)
	if e = archive.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: int64(len(raw))}); e == nil {
		_, e = archive.Write(raw)
	}
	for _, name := range names {
		if e != nil {
			break
		}
		entry := manifest.Files[name]
		e = archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: entry.Size})
		if e != nil {
			break
		}
		f, err := os.Open(sources[name])
		if err != nil {
			e = err
			break
		}
		_, e = io.Copy(archive, f)
		f.Close()
	}
	for _, err := range []error{archive.Close(), zip.Close(), out.Sync(), out.Close()} {
		if e == nil {
			e = err
		}
	}
	if e != nil {
		return e
	}
	if e = os.Rename(temp, output); e != nil {
		return e
	}
	fmt.Println("Full workspace backup:", output)
	return nil
}

func extractWorkspace(archive, stage string) (workspaceManifest, error) {
	var manifest workspaceManifest
	f, e := os.Open(archive)
	if e != nil {
		return manifest, e
	}
	defer f.Close()
	zip, e := gzip.NewReader(f)
	if e != nil {
		return manifest, e
	}
	defer zip.Close()
	reader := tar.NewReader(zip)
	first, e := reader.Next()
	if e != nil || first.Name != "manifest.json" || first.Size > 4*1024*1024 {
		return manifest, errors.New("missing or oversized backup manifest")
	}
	if e = json.NewDecoder(io.LimitReader(reader, first.Size)).Decode(&manifest); e != nil {
		return manifest, e
	}
	if manifest.Format != 1 || manifest.Schema < 1 || manifest.Schema > len(sqliteMigrations) {
		return manifest, errors.New("incompatible backup format or database schema")
	}
	seen := map[string]bool{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return manifest, err
		}
		name := header.Name
		entry, exists := manifest.Files[name]
		if !exists || seen[name] || !validPluginAssetPath(name) || header.Typeflag != tar.TypeReg || entry.Size < 0 || header.Size != entry.Size {
			return manifest, errors.New("unexpected or unsafe archive entry")
		}
		if !(name == "linkos.json" || strings.HasPrefix(name, "data/") || strings.HasPrefix(name, "uploads/") || strings.HasPrefix(name, "plugins/") || strings.HasPrefix(name, "tls/")) {
			return manifest, errors.New("unsupported archive path")
		}
		target := filepath.Join(stage, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return manifest, err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return manifest, err
		}
		hash := sha256.New()
		_, err = io.Copy(io.MultiWriter(out, hash), reader)
		closeErr := out.Close()
		if err != nil {
			return manifest, err
		}
		if closeErr != nil {
			return manifest, closeErr
		}
		if hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			return manifest, fmt.Errorf("checksum mismatch: %s", name)
		}
		seen[name] = true
	}
	if len(seen) != len(manifest.Files) || !seen["data/gateway.db"] || !seen["linkos.json"] {
		return manifest, errors.New("backup is incomplete")
	}
	// Consume gzip footer to verify its CRC, including truncated streams.
	if _, e = io.Copy(io.Discard, zip); e != nil {
		return manifest, e
	}
	if e = validateBackupFile(filepath.Join(stage, "data", "gateway.db")); e != nil {
		return manifest, e
	}
	v, e := databaseVersion(filepath.Join(stage, "data", "gateway.db"))
	if e != nil || v != manifest.Schema {
		return manifest, errors.New("manifest schema does not match database")
	}
	return manifest, nil
}

func restoreWorkspace(home, configFile string, target runtimeConfig, archive string, replace bool) error {
	if _, e := os.Stat(filepath.Join(target.DataDir, "gateway.db")); e == nil && !replace {
		return errors.New("workspace already contains a database; use --replace after backing it up")
	}
	stage, e := os.MkdirTemp(filepath.Dir(target.DataDir), ".linkos-restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stage)
	manifest, e := extractWorkspace(archive, stage)
	if e != nil {
		return e
	}
	var saved runtimeConfig
	raw, e := os.ReadFile(filepath.Join(stage, "linkos.json"))
	if e != nil {
		return e
	}
	if e = json.Unmarshal(raw, &saved); e != nil {
		return e
	}
	target.AdminPasscode = saved.AdminPasscode
	// Normalize storage to the target workspace; source-machine absolute paths
	// must never survive in upload metadata.
	newUpload := filepath.Join(target.DataDir, "uploads")
	target.UploadDir = newUpload
	if _, e = os.Stat(filepath.Join(stage, "uploads")); os.IsNotExist(e) {
		os.MkdirAll(filepath.Join(stage, "uploads"), 0700)
	}
	if e = os.Rename(filepath.Join(stage, "uploads"), filepath.Join(stage, "data", "uploads")); e != nil {
		return e
	}
	stagedBackend, e := newSQLiteBackend(filepath.Join(stage, "data", "gateway.db"))
	if e != nil {
		return e
	}
	db := stagedBackend.db
	rows, e := db.Query("SELECT id,directory,completed_path FROM uploads")
	if e != nil {
		db.Close()
		return e
	}
	type uploadPaths struct{ id, dir, completed string }
	updates := []uploadPaths{}
	for rows.Next() {
		var u uploadPaths
		if e = rows.Scan(&u.id, &u.dir, &u.completed); e != nil {
			break
		}
		updates = append(updates, u)
	}
	rowErr := rows.Err()
	rows.Close()
	if e == nil {
		e = rowErr
	}
	for _, u := range updates {
		if e != nil {
			break
		}
		rebase := func(old string) (string, error) {
			if old == "" {
				return "", nil
			}
			root := strings.TrimSuffix(strings.ReplaceAll(manifest.UploadRoot, "\\", "/"), "/")
			name := strings.ReplaceAll(old, "\\", "/")
			if !strings.HasPrefix(name, root+"/") {
				return "", errors.New("upload path escapes source workspace")
			}
			rel := strings.TrimPrefix(name, root+"/")
			if !validPluginAssetPath(rel) {
				return "", errors.New("upload path escapes source workspace")
			}
			return filepath.Join(newUpload, filepath.FromSlash(rel)), nil
		}
		dir, err := rebase(u.dir)
		if err != nil {
			e = err
			break
		}
		completed, err := rebase(u.completed)
		if err != nil {
			e = err
			break
		}
		_, e = db.Exec("UPDATE uploads SET directory=?,completed_path=? WHERE id=?", dir, completed, u.id)
	}
	if e == nil {
		_, e = db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	}
	db.Close()
	if e != nil {
		return e
	}
	// External plugins are restored within data so one directory swap installs
	// all application state. Network and TLS settings stay local to the target.
	if _, e = os.Stat(filepath.Join(stage, "plugins")); e == nil {
		target.PluginDir = filepath.Join(target.DataDir, "plugins")
		if e = os.Rename(filepath.Join(stage, "plugins"), filepath.Join(stage, "data", "plugins")); e != nil {
			return e
		}
		target.PluginTrustedKeys = saved.PluginTrustedKeys
	}
	if e = target.validate(); e != nil {
		return e
	}
	stashed := target.DataDir + ".before-restore-" + time.Now().UTC().Format("20060102T150405.000000000")
	existed := false
	if _, e = os.Stat(target.DataDir); e == nil {
		if e = os.Rename(target.DataDir, stashed); e != nil {
			return e
		}
		existed = true
	}
	if e = os.Rename(filepath.Join(stage, "data"), target.DataDir); e != nil {
		if existed {
			os.Rename(stashed, target.DataDir)
		}
		return e
	}
	if e = writePrivateJSON(configFile, target); e != nil {
		os.Rename(target.DataDir, filepath.Join(stage, "failed-data"))
		if existed {
			os.Rename(stashed, target.DataDir)
		}
		return e
	}
	if e = os.WriteFile(filepath.Join(home, "ADMIN-PASSCODE.txt"), []byte(target.AdminPasscode+"\n"), 0600); e != nil {
		return e
	}
	fmt.Printf("Restored workspace to %s\nPrevious data retained at %s\n", target.DataDir, stashed)
	return nil
}
