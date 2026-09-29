package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// errCASQuotaExceeded is returned when new content would exceed the
// content-store disk quota, without removing any existing objects.
var errCASQuotaExceeded = errors.New("content store disk quota exceeded")

// contentStore is a content-addressed object store under <root>/objects.
// Objects are keyed by the SHA-256 of their bytes, so identical uploads
// deduplicate to one file and a resourceId names the content rather than
// the upload session that produced it. When maxDiskBytes is positive,
// commits that would exceed it are rejected; shared objects are never evicted.
// Deleting a directory entry does not reclaim CAS bytes or quota headroom.
type contentStore struct {
	root         string
	maxDiskBytes int64
	mu           sync.Mutex
}

func newContentStore(root string) *contentStore {
	return newContentStoreWithQuota(root, 0)
}

// newContentStoreWithQuota creates a store bounded by maxDiskBytes; zero
// leaves the pool unlimited.
func newContentStoreWithQuota(root string, maxDiskBytes int64) *contentStore {
	_ = os.MkdirAll(root, 0o755)
	return &contentStore{root: root, maxDiskBytes: maxDiskBytes}
}

func (c *contentStore) objectPath(hash string) string {
	return filepath.Join(c.root, hash[:2], hash+".bin")
}

// commit moves the assembled temporary file into the store. When the same
// content is already present, the duplicate temporary file is discarded.
func (c *contentStore) commit(temporaryPath, hash string) (string, error) {
	path := c.objectPath(hash)
	if _, err := os.Stat(path); err == nil {
		_ = os.Remove(temporaryPath)
		return path, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := os.Stat(path); err == nil {
		_ = os.Remove(temporaryPath)
		return path, nil
	}
	if c.maxDiskBytes > 0 {
		info, err := os.Stat(temporaryPath)
		if err != nil {
			return "", err
		}
		if err := c.checkQuota(info.Size()); err != nil {
			if errors.Is(err, errCASQuotaExceeded) {
				_ = os.Remove(temporaryPath)
			}
			return "", err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", err
	}
	return path, nil
}

// checkQuota rejects new content that would exceed the quota without
// deleting existing objects. Callers hold c.mu and use a positive quota.
func (c *contentStore) checkQuota(incoming int64) error {
	if incoming > c.maxDiskBytes {
		return errCASQuotaExceeded
	}
	usage, err := c.scanObjects()
	if err != nil {
		return err
	}
	// Subtract to avoid overflowing when adding usage and incoming.
	if usage > c.maxDiskBytes-incoming {
		return errCASQuotaExceeded
	}
	return nil
}

func (c *contentStore) scanObjects() (int64, error) {
	var usage int64
	err := filepath.WalkDir(c.root, func(_ string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return infoErr
		}
		usage += info.Size()
		return nil
	})
	return usage, err
}

// touchObject records download time; quota decisions do not depend on recency.
func (c *contentStore) touchObject(path string) {
	now := time.Now()
	if err := os.Chtimes(path, now, now); err != nil {
		log.Printf("touch object %s: %v", path, err)
	}
}

// handleDownload serves GET /api/v1/files/sha256:<hash>/content with Range
// support: 200 for the full object, 206 for satisfiable ranges, 416 for
// ranges outside the object.
func (c *contentStore) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method_not_allowed")
		return
	}
	trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/files/"), "/")
	resourceID, suffix, found := strings.Cut(trimmed, "/")
	if !found || suffix != "content" {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "file not found")
		return
	}
	hash, ok := strings.CutPrefix(resourceID, "sha256:")
	if !ok || !isDigest(hash) {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "file not found")
		return
	}
	path := c.objectPath(hash)
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "file not found")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not read file")
		return
	}
	c.touchObject(path)
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", info.ModTime(), file)
}
