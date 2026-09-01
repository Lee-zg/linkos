package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultUploadChunkSize int64 = 8 * 1024 * 1024
	maxUploadChunkSize     int64 = 64 * 1024 * 1024
)

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
}

type uploadStore struct {
	mu       sync.Mutex
	root     string
	sessions map[string]*uploadSession
}

func defaultUploadRoot() string {
	if root := strings.TrimSpace(os.Getenv("LINKOS_UPLOAD_DIR")); root != "" {
		return root
	}
	return filepath.Join(os.TempDir(), "linkos-uploads")
}

func newUploadStore(root string) *uploadStore {
	if strings.TrimSpace(root) == "" {
		root = defaultUploadRoot()
	}
	_ = os.MkdirAll(root, 0o755)
	return &uploadStore{root: root, sessions: make(map[string]*uploadSession)}
}

func (s *uploadStore) handleCollection(w http.ResponseWriter, r *http.Request) {
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
	id := fmt.Sprintf("up_%d", time.Now().UnixNano())
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
	}
	if session.mimeType == "" {
		session.mimeType = "application/octet-stream"
	}
	s.mu.Lock()
	s.sessions[id] = session
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, uploadView(session))
}

func (s *uploadStore) handleItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/uploads/"), "/"), "/")
	if len(parts) == 0 || !isSafeUploadID(parts[0]) {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
		return
	}
	id := parts[0]
	if len(parts) == 1 && r.Method == http.MethodGet {
		session, ok := s.get(id)
		if !ok {
			writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "upload not found")
			return
		}
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
		s.handleComplete(w, r, id)
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
	if err := os.Remove(finalName); err != nil && !os.IsNotExist(err) {
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not replace existing part")
		return
	}
	if err := os.Rename(temporaryName, finalName); err != nil {
		s.mu.Unlock()
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not commit part")
		return
	}
	removeTemporary = false
	session.received[partNo] = written
	session.status = "uploading"
	view := uploadView(session)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uploadId":      id,
		"partNo":        partNo,
		"accepted":      true,
		"receivedParts": view.ReceivedParts,
	})
}

func (s *uploadStore) handleComplete(w http.ResponseWriter, r *http.Request, id string) {
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
		view := uploadView(session)
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]interface{}{"uploadId": id, "resourceId": view.ResourceID, "contentHash": view.ContentHash, "status": "completed"})
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
	session.status = "verifying"
	directory := session.directory
	totalParts := session.totalParts
	resourceID := "file_" + id
	s.mu.Unlock()

	completedPath := filepath.Join(directory, "complete")
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
	if written != session.size || !strings.EqualFold(actualHash, contentHash) {
		_ = os.Remove(temporaryName)
		s.markFailed(id)
		writeAPIError(w, http.StatusUnprocessableEntity, "UPLOAD_PART_INVALID", "full upload hash does not match")
		return
	}
	if err := os.Rename(temporaryName, completedPath); err != nil {
		_ = os.Remove(temporaryName)
		s.markFailed(id)
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not commit completed upload")
		return
	}
	s.mu.Lock()
	if current, exists := s.sessions[id]; exists {
		current.status = "completed"
		current.contentHash = actualHash
		current.resourceID = resourceID
		current.completedPath = completedPath
	}
	view := uploadView(s.sessions[id])
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"uploadId":    id,
		"resourceId":  view.ResourceID,
		"contentHash": view.ContentHash,
		"status":      "completed",
	})
}

func (s *uploadStore) markFailed(id string) {
	s.mu.Lock()
	if session, ok := s.sessions[id]; ok {
		session.status = "failed"
	}
	s.mu.Unlock()
}

func (s *uploadStore) get(id string) (*uploadSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	copySession := *session
	copySession.received = make(map[int]int64, len(session.received))
	for partNo, size := range session.received {
		copySession.received[partNo] = size
	}
	return &copySession, true
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
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
