package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultUploadChunkSize int64 = 8 * 1024 * 1024
	maxUploadChunkSize     int64 = 64 * 1024 * 1024

	defaultMaxUploadFileSize int64 = 10 * 1024 * 1024 * 1024
	defaultMaxActiveUploads  int   = 64
)

// uploadIDSequence disambiguates session ids created within the same clock
// tick; time.Now().UnixNano() alone collides on coarse-resolution clocks.
var uploadIDSequence uint64

type uploadSession struct {
	id            string
	name          string
	size          int64
	mimeType      string
	chunkSize     int64
	totalParts    int
	received      map[int]int64
	contentHash   string
	status        string
	directory     string
	resourceID    string
	completedPath string
	ownerID       string
	workspaceID   string
	parentID      string
	entryID       string
}

type uploadStore struct {
	mu               sync.Mutex
	root             string
	sessions         map[string]*uploadSession
	backend          persistBackend
	content          *contentStore
	maxFileSize      int64
	maxActiveUploads int
	auth             *authStore
	committer        directoryCommitter
	loadErr          error
}

type directoryCommitter interface {
	commitUploadEntry(session *uploadSession, contentHash string) (entryID, finalName string, err error)
}

// Implementations acquire the MVP lock after the caller's uploads lock and must
// never call back into uploadStore. Completion receives a private snapshot with
// verified CAS fields and status "verifying". It atomically persists the entry
// and completed snapshot through backend, then publishes MVP state and returns
// the completed snapshot (including the final name). Errors publish neither.
// A "completed" input is lookup-only: missing/deleted entries must not revive.
// The old directoryCommitter alone is deliberately insufficient for HTTP use.
type atomicDirectoryCommitter interface {
	validateUploadTarget(authPrincipal, string) error
	completeUploadEntry(authPrincipal, uploadSession, persistBackend) (uploadSession, error)
}

var (
	errUploadTargetNotFound = errors.New("upload parent not found")
	errUploadEntryNotFound  = errors.New("completed upload entry not found")
	errUploadTargetInvalid  = errors.New("upload parent must be a folder")
	errUploadForbidden      = errors.New("upload target permission denied")
)

func writeUploadCommitError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errUploadTargetNotFound):
		writeAPIError(w, http.StatusNotFound, "PARENT_NOT_FOUND", err.Error())
	case errors.Is(err, errUploadEntryNotFound):
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, errUploadTargetInvalid):
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, errUploadForbidden):
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	default:
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not commit upload directory entry")
	}
}

func (s *uploadStore) uploadPrincipal(w http.ResponseWriter, r *http.Request) (authPrincipal, bool) {
	principal, ok := principalForRequest(s.auth, r)
	if !ok || (s.auth != nil && (principal.UserID == "" || principal.WorkspaceID == "")) {
		writeAPIError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "valid workspace session required")
		return authPrincipal{}, false
	}
	if principal.Status != accessStatusActive || !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "active resource.write permission required")
		return authPrincipal{}, false
	}
	return principal, true
}

func defaultUploadRoot() string {
	if root := strings.TrimSpace(os.Getenv("LINKOS_UPLOAD_DIR")); root != "" {
		return root
	}
	return filepath.Join(os.TempDir(), "linkos-uploads")
}

func envInt64Limit(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		log.Printf("invalid %s=%q, falling back to %d", key, raw, fallback)
		return fallback
	}
	return value
}

func envIntLimit(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		log.Printf("invalid %s=%q, falling back to %d", key, raw, fallback)
		return fallback
	}
	return value
}

func newUploadStore(root string) *uploadStore {
	return newUploadStoreWithBackend(root, memoryBackend{})
}

// newUploadStoreWithBackend restores persisted upload sessions so in-flight
// uploads survive a gateway restart. A session interrupted mid-assembly
// ("verifying") downgrades to "uploading": completion is idempotent, so the
// client can safely re-submit the complete request.
func newUploadStoreWithBackend(root string, backend persistBackend) *uploadStore {
	if strings.TrimSpace(root) == "" {
		root = defaultUploadRoot()
	}
	_ = os.MkdirAll(root, 0o755)
	store := &uploadStore{
		root:             root,
		sessions:         make(map[string]*uploadSession),
		backend:          backend,
		content:          newContentStoreWithQuota(filepath.Join(root, "objects"), envInt64Limit("LINKOS_CAS_MAX_DISK_BYTES", 0)),
		maxFileSize:      envInt64Limit("LINKOS_UPLOAD_MAX_FILE_SIZE", defaultMaxUploadFileSize),
		maxActiveUploads: envIntLimit("LINKOS_UPLOAD_MAX_ACTIVE_UPLOADS", defaultMaxActiveUploads),
	}
	stored, err := backend.loadUploadSessions()
	if err != nil {
		store.loadErr = fmt.Errorf("load upload sessions: %w", err)
		return store
	}
	for i := range stored {
		session := stored[i]
		if session.status == "verifying" {
			session.status = "uploading"
		}
		if session.received == nil {
			session.received = make(map[int]int64)
		}
		store.sessions[session.id] = &session
	}
	if len(stored) > 0 {
		log.Printf("restored %d upload sessions", len(stored))
	}
	return store
}

// persistSessionLocked serializes every durable snapshot with state transitions.
// Callers publish the candidate only after this succeeds.
func (s *uploadStore) persistSessionLocked(session uploadSession) error {
	return s.backend.saveUploadSession(session)
}

func cloneUploadSession(session *uploadSession) uploadSession {
	clone := *session
	clone.received = make(map[int]int64, len(session.received))
	for partNo, size := range session.received {
		clone.received[partNo] = size
	}
	return clone
}

func (s *uploadStore) handleCollection(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.uploadPrincipal(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method_not_allowed")
		return
	}
	var input struct {
		Name        string `json:"name"`
		Size        int64  `json:"size"`
		MimeType    string `json:"mimeType"`
		ContentHash string `json:"contentHash"`
		ChunkSize   int64  `json:"chunkSize"`
		ParentID    string `json:"parentId"`
		OwnerID     string `json:"ownerId"`
		WorkspaceID string `json:"workspaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid upload request")
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || strings.ContainsAny(name, `/\\`) || input.Size < 0 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "name and size are invalid")
		return
	}
	if s.auth != nil {
		input.OwnerID, input.WorkspaceID = principal.UserID, principal.WorkspaceID
	}
	if s.maxFileSize > 0 && input.Size > s.maxFileSize {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "file exceeds the upload size limit")
		return
	}
	chunkSize := input.ChunkSize
	if chunkSize == 0 {
		chunkSize = defaultUploadChunkSize
	}
	if chunkSize < 1 || chunkSize > maxUploadChunkSize {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "chunkSize is outside the allowed range")
		return
	}
	contentHash := strings.ToLower(strings.TrimSpace(input.ContentHash))
	if contentHash != "" && !isDigest(contentHash) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "contentHash must be a SHA-256 digest")
		return
	}
	totalParts := int((input.Size + chunkSize - 1) / chunkSize)
	if totalParts == 0 {
		totalParts = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeSessionCountLocked() >= s.maxActiveUploads {
		writeAPIError(w, http.StatusTooManyRequests, "TOO_MANY_ACTIVE_UPLOADS", "too many uploads in progress, try again later")
		return
	}
	if s.auth != nil || strings.TrimSpace(input.OwnerID) != "" {
		committer, ok := s.committer.(atomicDirectoryCommitter)
		if !ok {
			writeAPIError(w, http.StatusServiceUnavailable, "INTERNAL_ERROR", "atomic upload directory committer unavailable")
			return
		}
		if err := committer.validateUploadTarget(principal, strings.TrimSpace(input.ParentID)); err != nil {
			writeUploadCommitError(w, err)
			return
		}
	}
	id := fmt.Sprintf("up_%d_%d", time.Now().UnixNano(), atomic.AddUint64(&uploadIDSequence, 1))
	directory := filepath.Join(s.root, id)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create upload directory")
		return
	}
	session := &uploadSession{
		id:          id,
		name:        name,
		size:        input.Size,
		mimeType:    strings.TrimSpace(input.MimeType),
		chunkSize:   chunkSize,
		totalParts:  totalParts,
		received:    make(map[int]int64),
		contentHash: contentHash,
		status:      "created",
		directory:   directory,
		ownerID:     strings.TrimSpace(input.OwnerID),
		workspaceID: strings.TrimSpace(input.WorkspaceID),
		parentID:    strings.TrimSpace(input.ParentID),
	}
	if session.mimeType == "" {
		session.mimeType = "application/octet-stream"
	}
	if session.ownerID != "" {
		var random [12]byte
		if _, err := rand.Read(random[:]); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create entry id")
			_ = os.RemoveAll(directory)
			return
		}
		session.entryID = "res_" + base64.RawURLEncoding.EncodeToString(random[:])
	}
	if err := s.persistSessionLocked(cloneUploadSession(session)); err != nil {
		s.removeSessionDirectory(directory)
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist upload session")
		return
	}
	s.sessions[id] = session
	writeJSON(w, http.StatusCreated, uploadView(session))
}

func (s *uploadStore) handleItem(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.uploadPrincipal(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/uploads/"), "/"), "/")
	if len(parts) == 0 || !isSafeUploadID(parts[0]) {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
		return
	}
	id := parts[0]
	session, ok := s.get(id)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
		return
	}
	// Identity is immutable for the life of a session. Ownerless historical
	// sessions are not claimable once authentication is configured.
	if s.auth != nil && (session.ownerID != principal.UserID || session.workspaceID != principal.WorkspaceID) {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "upload belongs to another owner or workspace")
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, uploadView(session))
		return
	}
	if len(parts) == 3 && parts[1] == "parts" && r.Method == http.MethodPatch {
		partNo, err := strconv.Atoi(parts[2])
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "part number is invalid")
			return
		}
		s.handlePart(w, r, id, partNo)
		return
	}
	if len(parts) == 2 && parts[1] == "complete" && r.Method == http.MethodPost {
		s.handleComplete(w, r, id, principal)
		return
	}
	writeAPIError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "unsupported upload operation")
}

func (s *uploadStore) handlePart(w http.ResponseWriter, r *http.Request, id string, partNo int) {
	s.mu.Lock()
	session, ok := s.sessions[id]
	if !ok {
		s.mu.Unlock()
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
		return
	}
	if session.status != "created" && session.status != "uploading" {
		s.mu.Unlock()
		writeAPIError(w, http.StatusConflict, "INVALID_REQUEST", "upload is not accepting parts")
		return
	}
	if partNo < 0 || partNo >= session.totalParts {
		s.mu.Unlock()
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "part number is outside the upload")
		return
	}
	expectedSize := session.chunkSize
	if partNo == session.totalParts-1 {
		expectedSize = session.size - session.chunkSize*int64(session.totalParts-1)
		if expectedSize < 0 {
			expectedSize = 0
		}
	}
	directory := session.directory
	chunkSize := session.chunkSize
	s.mu.Unlock()

	expectedHash := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Part-SHA256")))
	if !isDigest(expectedHash) {
		writeAPIError(w, http.StatusBadRequest, "UPLOAD_PART_INVALID", "X-Part-SHA256 is required")
		return
	}
	temporary, err := os.CreateTemp(directory, ".part-*")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create temporary part")
		return
	}
	temporaryName := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryName)
		}
	}()
	limitedBody := http.MaxBytesReader(w, r.Body, chunkSize+1)
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hasher), limitedBody)
	if err != nil {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "UPLOAD_PART_INVALID", "part exceeds chunk size")
		return
	}
	if written != expectedSize || !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), expectedHash) {
		writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "part size or hash does not match")
		return
	}
	if err := temporary.Close(); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist part")
		return
	}
	s.mu.Lock()
	if session.status != "created" && session.status != "uploading" {
		s.mu.Unlock()
		writeAPIError(w, http.StatusConflict, "INVALID_REQUEST", "upload changed while part was sent")
		return
	}
	finalName := filepath.Join(directory, fmt.Sprintf("part-%08d", partNo))
	previousName := temporaryName + ".previous"
	previousExists := false
	if err := os.Rename(finalName, previousName); err == nil {
		previousExists = true
	} else if !os.IsNotExist(err) {
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not replace existing part")
		return
	}
	restorePrevious := func() {
		_ = os.Remove(finalName)
		if previousExists {
			if err := os.Rename(previousName, finalName); err != nil {
				log.Printf("restore upload part %s/%d: %v", id, partNo, err)
			}
		}
	}
	if err := os.Rename(temporaryName, finalName); err != nil {
		restorePrevious()
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not commit part")
		return
	}
	removeTemporary = false
	snapshot := cloneUploadSession(session)
	snapshot.received[partNo] = written
	snapshot.status = "uploading"
	if err := s.persistSessionLocked(snapshot); err != nil {
		restorePrevious()
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist uploaded part")
		return
	}
	if previousExists {
		_ = os.Remove(previousName)
	}
	*session = snapshot
	view := uploadView(session)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uploadId":      id,
		"partNo":        partNo,
		"accepted":      true,
		"receivedParts": view.ReceivedParts,
	})
}

func (s *uploadStore) handleComplete(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	var input struct {
		ContentHash string `json:"contentHash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid completion request")
		return
	}
	contentHash := strings.ToLower(strings.TrimSpace(input.ContentHash))
	if !isDigest(contentHash) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "contentHash must be a SHA-256 digest")
		return
	}
	s.mu.Lock()
	session, ok := s.sessions[id]
	if !ok {
		s.mu.Unlock()
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
		return
	}
	if session.status == "completed" {
		if session.contentHash != contentHash {
			s.mu.Unlock()
			writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "content hash does not match completed upload")
			return
		}
		snapshot := cloneUploadSession(session)
		if session.entryID != "" || s.auth != nil {
			committer, supported := s.committer.(atomicDirectoryCommitter)
			if !supported {
				s.mu.Unlock()
				writeAPIError(w, http.StatusServiceUnavailable, "INTERNAL_ERROR", "atomic upload directory committer unavailable")
				return
			}
			var err error
			snapshot, err = committer.completeUploadEntry(principal, snapshot, s.backend)
			if err != nil {
				s.mu.Unlock()
				writeUploadCommitError(w, err)
				return
			}
		}
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, uploadCompletionView(&snapshot))
		return
	}
	if session.status != "created" && session.status != "uploading" {
		s.mu.Unlock()
		writeAPIError(w, http.StatusConflict, "INVALID_REQUEST", "upload is not ready to complete")
		return
	}
	if session.contentHash != "" && session.contentHash != contentHash {
		s.mu.Unlock()
		writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "content hash does not match upload declaration")
		return
	}
	for partNo := 0; partNo < session.totalParts; partNo++ {
		if _, exists := session.received[partNo]; !exists {
			s.mu.Unlock()
			writeAPIError(w, http.StatusConflict, "UPLOAD_PART_INVALID", "upload is missing one or more parts")
			return
		}
	}
	previousStatus := session.status
	session.status = "verifying"
	// Verification is an in-flight reservation only. Durable state stays
	// retryable until the joint commit succeeds.
	snapshot := cloneUploadSession(session)
	directory := snapshot.directory
	totalParts := snapshot.totalParts
	s.mu.Unlock()

	temporary, err := os.CreateTemp(directory, ".complete-*")
	if err != nil {
		s.markFailed(id)
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create completed file")
		return
	}
	temporaryName := temporary.Name()
	hasher := sha256.New()
	written := int64(0)
	for partNo := 0; partNo < totalParts; partNo++ {
		part, err := os.Open(filepath.Join(directory, fmt.Sprintf("part-%08d", partNo)))
		if err != nil {
			_ = temporary.Close()
			_ = os.Remove(temporaryName)
			s.markFailed(id)
			writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "could not read uploaded part")
			return
		}
		copied, copyErr := io.Copy(io.MultiWriter(temporary, hasher), part)
		_ = part.Close()
		if copyErr != nil {
			_ = temporary.Close()
			_ = os.Remove(temporaryName)
			s.markFailed(id)
			writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not assemble upload")
			return
		}
		written += copied
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryName)
		s.markFailed(id)
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not finalize upload")
		return
	}
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if written != snapshot.size || !strings.EqualFold(actualHash, contentHash) {
		_ = os.Remove(temporaryName)
		s.markFailed(id)
		writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "full upload hash does not match")
		return
	}
	objectPath, err := s.content.commit(temporaryName, actualHash)
	if err != nil {
		_ = os.Remove(temporaryName)
		s.markFailed(id)
		if errors.Is(err, errCASQuotaExceeded) {
			writeAPIError(w, http.StatusInsufficientStorage, "INSUFFICIENT_STORAGE", "object exceeds the content store disk quota")
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not commit completed upload")
		return
	}
	snapshot.contentHash = actualHash
	snapshot.resourceID = "sha256:" + actualHash
	snapshot.completedPath = objectPath
	s.mu.Lock()
	if snapshot.entryID != "" || s.auth != nil {
		committer, supported := s.committer.(atomicDirectoryCommitter)
		if !supported {
			session.status = previousStatus
			s.mu.Unlock()
			writeAPIError(w, http.StatusServiceUnavailable, "INTERNAL_ERROR", "atomic upload directory committer unavailable")
			return
		}
		snapshot, err = committer.completeUploadEntry(principal, snapshot, s.backend)
	} else {
		snapshot.status = "completed"
		err = s.persistSessionLocked(snapshot)
	}
	if err != nil {
		// The CAS object is immutable and may remain deduplicated, but retain
		// all parts and the original entry ID so the same session can retry.
		session.status = previousStatus
		s.mu.Unlock()
		writeUploadCommitError(w, err)
		return
	}
	*session = snapshot
	s.mu.Unlock()
	s.removeSessionDirectory(directory)
	writeJSON(w, http.StatusCreated, uploadCompletionView(&snapshot))
}

func uploadCompletionView(session *uploadSession) map[string]interface{} {
	response := map[string]interface{}{
		"uploadId":    session.id,
		"resourceId":  session.resourceID,
		"contentHash": session.contentHash,
		"status":      session.status,
		"name":        session.name,
		"finalName":   session.name,
	}
	if session.entryID != "" {
		response["entryId"] = session.entryID
	}
	return response
}

func (s *uploadStore) markFailed(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session, ok := s.sessions[id]; ok {
		snapshot := cloneUploadSession(session)
		snapshot.status = "failed"
		snapshot.directory = ""
		if err := s.persistSessionLocked(snapshot); err != nil {
			log.Printf("persist failed upload %s: %v", id, err)
			session.status = "uploading"
			return
		}
		directory := session.directory
		*session = snapshot
		s.removeSessionDirectory(directory)
	}
}

func (s *uploadStore) get(id string) (*uploadSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	clone := cloneUploadSession(session)
	return &clone, true
}

// activeSessionCount reports how many uploads are still in flight. Completed
// and failed sessions free their slot; their on-disk state is cleaned up.
func (s *uploadStore) activeSessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeSessionCountLocked()
}

func (s *uploadStore) activeSessionCountLocked() int {
	count := 0
	for _, session := range s.sessions {
		switch session.status {
		case "created", "uploading", "verifying":
			count++
		}
	}
	return count
}

// removeSessionDirectory best-effort deletes a finished session's part files.
// Failures are logged only; the upload itself has already been committed or
// rejected, so cleanup must not change the API outcome.
func (s *uploadStore) removeSessionDirectory(directory string) {
	if strings.TrimSpace(directory) == "" {
		return
	}
	if err := os.RemoveAll(directory); err != nil {
		log.Printf("remove upload directory %s: %v", directory, err)
	}
}

type uploadViewModel struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Size          int64  `json:"size"`
	MimeType      string `json:"mimeType"`
	ChunkSize     int64  `json:"chunkSize"`
	TotalParts    int    `json:"totalParts"`
	ReceivedParts []int  `json:"receivedParts"`
	Status        string `json:"status"`
	ContentHash   string `json:"contentHash,omitempty"`
	ResourceID    string `json:"resourceId,omitempty"`
	ParentID      string `json:"parentId,omitempty"`
	OwnerID       string `json:"ownerId,omitempty"`
	WorkspaceID   string `json:"workspaceId,omitempty"`
	EntryID       string `json:"entryId,omitempty"`
}

func uploadView(session *uploadSession) uploadViewModel {
	receivedParts := make([]int, 0, len(session.received))
	for partNo := range session.received {
		receivedParts = append(receivedParts, partNo)
	}
	sort.Ints(receivedParts)
	return uploadViewModel{
		ID:            session.id,
		Name:          session.name,
		Size:          session.size,
		MimeType:      session.mimeType,
		ChunkSize:     session.chunkSize,
		TotalParts:    session.totalParts,
		ReceivedParts: receivedParts,
		Status:        session.status,
		ContentHash:   session.contentHash,
		ResourceID:    session.resourceID,
		ParentID:      session.parentID,
		OwnerID:       session.ownerID,
		WorkspaceID:   session.workspaceID,
		EntryID:       session.entryID,
	}
}

func isDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isSafeUploadID(value string) bool {
	if value == "" || len(value) > 80 || strings.Contains(value, "..") {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	traceID := fmt.Sprintf("tr_%x", time.Now().UTC().UnixNano())
	w.Header().Set("X-Trace-ID", traceID)
	writeJSON(w, status, map[string]string{"error": code, "message": message, "traceId": traceID})
}
