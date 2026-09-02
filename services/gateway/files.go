package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// errCASQuotaExceeded is returned when a single object is larger than the
// whole content-store disk quota, so it can never be stored.
var errCASQuotaExceeded = errors.New("object exceeds the content store disk quota")

// contentStore is a content-addressed object store under <root>/objects.
// Objects are keyed by the SHA-256 of their bytes, so identical uploads
// deduplicate to one file and a resourceId names the content rather than
// the upload session that produced it. When maxDiskBytes is positive the
// pool is quota-bounded: commits that would exceed it evict objects with
// the oldest modification time first (downloads refresh mtime, making the
// policy LRU). Evicted objects lose their resourceId targets.
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
		size := info.Size()
		if size > c.maxDiskBytes {
			_ = os.Remove(temporaryPath)
			return "", errCASQuotaExceeded
		}
		if err := c.makeRoom(size); err != nil {
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

type objectEntry struct {
	path    string
	size    int64
	modTime time.Time
}

// makeRoom evicts the least recently used objects until the incoming size
// fits under the quota. Callers hold c.mu.
func (c *contentStore) makeRoom(incoming int64) error {
	usage, candidates, err := c.scanObjects()
	if err != nil {
		return err
	}
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].modTime.Equal(candidates[j].modTime) {
			return candidates[i].modTime.Before(candidates[j].modTime)
		}
		return candidates[i].path < candidates[j].path
	})
	for _, victim := range candidates {
		if usage+incoming <= c.maxDiskBytes {
			break
		}
		if err := os.Remove(victim.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		usage -= victim.size
		log.Printf("content store quota: evicted %s (%d bytes)", victim.path, victim.size)
	}
	return nil
}

func (c *contentStore) scanObjects() (int64, []objectEntry, error) {
	var usage int64
	var entries []objectEntry
	err := filepath.WalkDir(c.root, func(path string, d os.DirEntry, walkErr error) error {
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
		entries = append(entries, objectEntry{path: path, size: info.Size(), modTime: info.ModTime()})
		return nil
	})
	return usage, entries, err
}

// touchObject refreshes the object's modification time so quota eviction
// treats it as recently used. Failures only degrade eviction ordering.
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
