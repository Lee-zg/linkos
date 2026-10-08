package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

var fileTypes = map[string]bool{"file": true, "folder": true}

func validateResourceName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", fmt.Errorf("name is required")
	}
	if trimmed == "." || trimmed == ".." {
		return "", fmt.Errorf("name cannot be . or ..")
	}
	if strings.ContainsAny(trimmed, "/\\") {
		return "", fmt.Errorf("name cannot contain slashes")
	}
	if utf8.RuneCountInString(trimmed) != len([]rune(trimmed)) {
		return "", fmt.Errorf("name has invalid encoding")
	}
	// Validate the original input so trimming cannot hide tabs or newlines.
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("name cannot contain control characters")
		}
	}
	if len([]byte(trimmed)) > 255 {
		return "", fmt.Errorf("name exceeds 255 bytes")
	}
	return trimmed, nil
}

func (s *mvpStore) bumpResourceRevision() {
	s.resourceRev++
}

// Callers hold s.mu throughout candidate construction, durable save and publish.
// Copy the latest complete state so unrelated chat/code/job updates are retained.
func (s *mvpStore) directoryCandidateLocked() mvpState {
	candidate := s.state
	candidate.Resources = make(map[string]protocol.ResourceRecord, len(s.state.Resources))
	for id, item := range s.state.Resources {
		candidate.Resources[id] = item
	}
	candidate.Shares = make(map[string]protocol.ResourceShareLink, len(s.state.Shares))
	for token, share := range s.state.Shares {
		candidate.Shares[token] = share
	}
	return candidate
}

func cloneDirectoryItem(item protocol.ResourceRecord) protocol.ResourceRecord {
	if item.Meta != nil {
		meta := make(map[string]interface{}, len(item.Meta))
		for key, value := range item.Meta {
			meta[key] = value // PATCH replaces values; it never edits nested values.
		}
		item.Meta = meta
	}
	if item.ACL.Grants != nil {
		item.ACL.Grants = append([]protocol.ResourceGrant(nil), item.ACL.Grants...)
		for i := range item.ACL.Grants {
			item.ACL.Grants[i].Actions = append([]string(nil), item.ACL.Grants[i].Actions...)
		}
	}
	return item
}

func defaultFileACL(ownerID string) protocol.ResourceACL {
	return protocol.ResourceACL{OwnerID: ownerID, Grants: []protocol.ResourceGrant{
		{Subject: "*", Actions: []string{"resource.read"}},
	}}
}

func (s *mvpStore) saveDirectoryCandidateLocked(candidate mvpState) error {
	backend, ok := s.backend.(mvpBlobBackend)
	if !ok {
		return fmt.Errorf("directory persistence unavailable")
	}
	raw, err := json.Marshal(candidate)
	if err != nil {
		return err
	}
	if err := backend.saveMVPState(raw); err != nil {
		return err
	}
	s.state = candidate
	return nil
}

func (s *mvpStore) directoryChangedLocked() {
	s.bumpResourceRevision()
	if s.hub != nil {
		// Broadcast only invalidation: directory names and IDs may be private.
		s.hub.emit("resources.changed", map[string]interface{}{})
	}
}

func (s *mvpStore) isDescendantOf(ancestorID, candidateID string) bool {
	current := candidateID
	for current != "" {
		if current == ancestorID {
			return true
		}
		res, ok := s.state.Resources[current]
		if !ok {
			return false
		}
		current = res.ParentID
	}
	return false
}

func (s *mvpStore) hasNameConflict(parentID, name, excludeID string) bool {
	for _, item := range s.state.Resources {
		if !fileTypes[item.Type] {
			continue
		}
		if item.ParentID != parentID {
			continue
		}
		if item.ID == excludeID {
			continue
		}
		if strings.EqualFold(item.Name, name) {
			return true
		}
	}
	return false
}

func (s *mvpStore) countChildren(id string) int {
	n := 0
	for _, item := range s.state.Resources {
		if item.ParentID == id {
			n++
		}
	}
	return n
}

func (s *mvpStore) collectSubtree(id string) []string {
	result := []string{id}
	for _, item := range s.state.Resources {
		if item.ParentID == id {
			result = append(result, s.collectSubtree(item.ID)...)
		}
	}
	return result
}

type fileItemView struct {
	protocol.ResourceRecord
	CanRead        bool `json:"canRead"`
	CanWrite       bool `json:"canWrite"`
	CanCreateChild bool `json:"canCreateChild"`
}

type fileAncestor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// File permissions are scoped to the current single workspace, even for admins.
func fileResourceAllows(principal authPrincipal, item protocol.ResourceRecord, action string) bool {
	if owner, _ := item.Meta["personalOwner"].(string); owner != "" && owner != principal.UserID {
		return false
	}
	if principal.WorkspaceID != "demo" || item.WorkspaceID != "demo" || !roleAllows(principal.Role, action) {
		return false
	}
	if principal.Role == roleAdmin || principal.Role == roleOwner ||
		(item.OwnerID != "" && item.OwnerID != "system" && item.OwnerID == principal.UserID) {
		return true
	}
	for _, grant := range item.ACL.Grants {
		if grant.Subject != principal.UserID && grant.Subject != principal.Role && grant.Subject != "*" {
			continue
		}
		for _, candidate := range grant.Actions {
			if candidate == action || candidate == "*" {
				return true
			}
		}
	}
	return false
}

// fileAncestors and itemView require s.mu to be held by the caller. They never
// re-lock it, so the same authorization snapshot is used for reads and mutations.
func (s *mvpStore) fileAncestors(principal authPrincipal, item protocol.ResourceRecord) ([]fileAncestor, bool) {
	ancestors := make([]fileAncestor, 0)
	if !roleAllows(principal.Role, "resource.read") {
		return ancestors, false
	}
	seen := make(map[string]bool)
	for {
		if seen[item.ID] || !fileResourceAllows(principal, item, "resource.read") {
			return nil, false
		}
		seen[item.ID] = true
		ancestors = append(ancestors, fileAncestor{ID: item.ID, Name: item.Name})
		if item.ParentID == "" {
			break
		}
		parent, exists := s.state.Resources[item.ParentID]
		if !exists || parent.Type != "folder" {
			return nil, false
		}
		item = parent
	}
	for i, j := 0, len(ancestors)-1; i < j; i, j = i+1, j-1 {
		ancestors[i], ancestors[j] = ancestors[j], ancestors[i]
	}
	return ancestors, true
}

func (s *mvpStore) itemView(principal authPrincipal, item protocol.ResourceRecord) fileItemView {
	_, read := s.fileAncestors(principal, item)
	write := read && fileResourceAllows(principal, item, "resource.write")
	canCreateChild := write && item.Type == "folder"
	if item.Meta["systemLocation"] != nil {
		write = false
	}
	// Renaming, moving or deleting an entry also mutates its source directory.
	// Creating a child only requires write on the current directory, not its parent.
	if write && item.ParentID != "" {
		parent := s.state.Resources[item.ParentID] // Existence/visibility checked above.
		write = fileResourceAllows(principal, parent, "resource.write")
	}
	return fileItemView{
		ResourceRecord: item,
		CanRead:        read,
		CanWrite:       write,
		CanCreateChild: canCreateChild,
	}
}

type filesCursor struct {
	Version  int    `json:"version"`
	Revision int64  `json:"revision"`
	Offset   int    `json:"offset"`
	Query    string `json:"query"`
}

func fileSize(item protocol.ResourceRecord) float64 {
	// Uploaded and persisted metadata uses float64; internal records may use ints.
	switch size := item.Meta["size"].(type) {
	case float64:
		return size
	case int64:
		return float64(size)
	case int:
		return float64(size)
	case json.Number:
		value, _ := size.Float64()
		return value
	default:
		return 0
	}
}

func (s *mvpStore) handleFilesResources(w http.ResponseWriter, r *http.Request) {
	principal, _ := principalForRequest(s.authFromHub(), r)

	switch r.Method {
	case http.MethodGet:
		scope := strings.TrimSpace(r.URL.Query().Get("scope"))
		if scope == "files" {
			s.handleFilesList(w, r, principal)
		} else {
			s.handleLegacyListResources(w, r, principal)
		}
	case http.MethodPost:
		s.handleFilesCreate(w, r, principal)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (s *mvpStore) handleFilesList(w http.ResponseWriter, r *http.Request, principal authPrincipal) {
	q := r.URL.Query()
	recent := strings.TrimSpace(q.Get("recent")) == "true"
	_, hasParent := q["parentId"]
	parentID := strings.TrimSpace(q.Get("parentId"))
	search := strings.TrimSpace(q.Get("q"))
	sortBy := strings.TrimSpace(q.Get("sortBy"))
	sortOrder := strings.TrimSpace(q.Get("sortOrder"))
	cursorStr := strings.TrimSpace(q.Get("cursor"))
	limit := parseLimit(q.Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}

	if sortBy == "" {
		sortBy = "updatedAt"
	}
	if sortOrder == "" {
		sortOrder = "asc"
	}
	// Bind the cursor to the filters, ordering and identity, but not page size.
	queryJSON, _ := json.Marshal([]interface{}{hasParent, parentID, recent, search, sortBy, sortOrder, principal.WorkspaceID, principal.UserID, principal.Role})
	queryHash := sha256.Sum256(queryJSON)
	queryKey := base64.RawURLEncoding.EncodeToString(queryHash[:])
	cursor := filesCursor{Version: 1, Query: queryKey}
	if cursorStr != "" {
		raw, err := base64.RawURLEncoding.Strict().DecodeString(cursorStr)
		// Required fields must not silently default to zero on malformed input.
		var decoded struct {
			Version  int    `json:"version"`
			Revision *int64 `json:"revision"`
			Offset   *int   `json:"offset"`
			Query    string `json:"query"`
		}
		if err != nil || json.Unmarshal(raw, &decoded) != nil || decoded.Version != 1 || decoded.Revision == nil || decoded.Offset == nil || *decoded.Revision < 0 || *decoded.Offset < 0 || decoded.Query != queryKey {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid cursor or cursor does not match query")
			return
		}
		cursor.Revision, cursor.Offset = *decoded.Revision, *decoded.Offset
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	ancestors := make([]fileAncestor, 0)
	canRead := roleAllows(principal.Role, "resource.read")
	canWrite := roleAllows(principal.Role, "resource.write")
	canCreateChild := canWrite
	if parentID != "" {
		parent, exists := s.state.Resources[parentID]
		if !exists {
			writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "parent resource not found")
			return
		}
		var readable bool
		ancestors, readable = s.fileAncestors(principal, parent)
		if !readable {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "parent or ancestor permission denied")
			return
		}
		if parent.Type != "folder" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "parent must be a folder")
			return
		}
		view := s.itemView(principal, parent)
		canRead, canWrite, canCreateChild = view.CanRead, view.CanWrite, view.CanCreateChild
		// Personal system entries cannot be renamed, but their contents are writable.
		if parent.Meta["systemLocation"] != nil {
			canWrite = view.CanCreateChild
		}
	}
	if !canRead {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.read permission required")
		return
	}
	if cursorStr != "" && cursor.Revision != s.resourceRev {
		writeAPIError(w, http.StatusConflict, "CURSOR_STALE", "directory has been modified; cursor is no longer valid")
		return
	}

	items := make([]fileItemView, 0)
	for _, item := range s.state.Resources {
		if !fileTypes[item.Type] || (recent && item.Type != "file") || (!recent && hasParent && item.ParentID != parentID) {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(item.Name), strings.ToLower(search)) {
			continue
		}
		view := s.itemView(principal, item)
		if view.CanRead {
			items = append(items, view)
		}
	}
	if recent {
		sortBy, sortOrder = "updatedAt", "desc"
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Type == "folder" && items[j].Type != "folder" {
			return true
		}
		if items[i].Type != "folder" && items[j].Type == "folder" {
			return false
		}
		cmp := 0
		switch sortBy {
		case "name":
			cmp = strings.Compare(strings.ToLower(items[i].Name), strings.ToLower(items[j].Name))
		case "size":
			a, b := fileSize(items[i].ResourceRecord), fileSize(items[j].ResourceRecord)
			if a < b {
				cmp = -1
			} else if a > b {
				cmp = 1
			}
		default:
			cmp = strings.Compare(items[i].UpdatedAt, items[j].UpdatedAt)
		}
		if cmp != 0 {
			if sortOrder == "desc" {
				return cmp > 0
			}
			return cmp < 0
		}
		return items[i].ID < items[j].ID
	})

	start := cursor.Offset
	if start > len(items) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "cursor offset is out of range")
		return
	}
	end := start + minInt(limit, len(items)-start)
	nextCursor := ""
	if end < len(items) {
		cursor.Revision, cursor.Offset = s.resourceRev, end
		raw, _ := json.Marshal(cursor)
		nextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}

	type page struct {
		Items          []fileItemView `json:"items"`
		NextCursor     string         `json:"nextCursor"`
		Total          int            `json:"total"`
		Ancestors      []fileAncestor `json:"ancestors"`
		CanRead        bool           `json:"canRead"`
		CanWrite       bool           `json:"canWrite"`
		CanCreateChild bool           `json:"canCreateChild"`
	}
	writeJSON(w, http.StatusOK, page{
		Items: items[start:end], NextCursor: nextCursor, Total: len(items), Ancestors: ancestors,
		CanRead: canRead, CanWrite: canWrite, CanCreateChild: canCreateChild,
	})
}

func (s *mvpStore) handleFilesCreate(w http.ResponseWriter, r *http.Request, principal authPrincipal) {
	if principal.WorkspaceID != "demo" || !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
		return
	}
	var input struct {
		Type     string `json:"type"`
		Name     string `json:"name"`
		ParentID string `json:"parentId"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input) != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body")
		return
	}
	name, err := validateResourceName(input.Name)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if input.Type == "" {
		input.Type = "folder"
	}
	if input.Type != "folder" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "only folders can be created here; files require the upload pipeline")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if input.ParentID != "" {
		parent, exists := s.state.Resources[input.ParentID]
		if !exists {
			writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "parent resource not found")
			return
		}
		if parent.Type != "folder" {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "parent must be a folder")
			return
		}
		if !s.itemView(principal, parent).CanCreateChild {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "parent or ancestor permission denied")
			return
		}
	}

	if s.hasNameConflict(input.ParentID, name, "") {
		writeAPIError(w, http.StatusConflict, "NAME_CONFLICT", "a resource with that name already exists in the target directory")
		return
	}

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create resource id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	item := protocol.ResourceRecord{
		ID:          "res_" + base64.RawURLEncoding.EncodeToString(random[:]),
		WorkspaceID: "demo",
		Type:        input.Type,
		Name:        name,
		ParentID:    input.ParentID,
		OwnerID:     principal.UserID,
		ACL:         defaultFileACL(principal.UserID),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	candidate := s.directoryCandidateLocked()
	candidate.Resources[item.ID] = item
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist resource")
		return
	}
	s.directoryChangedLocked()
	s.recordMutationLocked("resource.create", principal, item.ID, item.Type)

	writeJSON(w, http.StatusCreated, s.itemView(principal, item))
}

func (s *mvpStore) handleFilesResourceItem(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/resources/"), "/")
	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}

	principal, _ := principalForRequest(s.authFromHub(), r)

	if len(parts) > 1 && parts[1] == "share" {
		s.handleResourceShare(w, r, id, principal)
		return
	}

	s.mu.RLock()
	item, exists := s.state.Resources[id]
	s.mu.RUnlock()
	if !exists {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}

	if !fileTypes[item.Type] {
		s.handleLegacyResourceItem(w, r, id, principal)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleFilesGet(w, r, id, principal)
	case http.MethodPatch:
		s.handleFilesPatch(w, r, id, principal)
	case http.MethodDelete:
		s.handleFilesDelete(w, r, id, principal)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (s *mvpStore) handleFilesGet(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, exists := s.state.Resources[id]
	if !exists {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	if !s.itemView(principal, item).CanRead {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource or ancestor permission denied")
		return
	}
	item.LastAccessedAt = time.Now().UTC().Format(time.RFC3339)
	candidate := s.directoryCandidateLocked()
	candidate.Resources[id] = item
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist resource access")
		return
	}
	writeJSON(w, http.StatusOK, s.itemView(principal, item))
}

func (s *mvpStore) handleFilesPatch(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	if !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
		return
	}

	var input struct {
		Name     *string                `json:"name"`
		ParentID *string                `json:"parentId"`
		Meta     map[string]interface{} `json:"meta"`
		ACL      *protocol.ResourceACL  `json:"acl"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input) != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	item, exists := s.state.Resources[id]
	if !exists {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	if !s.itemView(principal, item).CanWrite {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource, source parent or ancestor permission denied")
		return
	}

	newName := item.Name
	newParentID := item.ParentID

	if input.Name != nil {
		n, err := validateResourceName(*input.Name)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
			return
		}
		newName = n
	}

	if input.ParentID != nil {
		target := strings.TrimSpace(*input.ParentID)
		if target == id {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "cannot move into itself")
			return
		}
		if target != "" {
			parent, exists := s.state.Resources[target]
			if !exists {
				writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "parent resource not found")
				return
			}
			if parent.Type != "folder" {
				writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "parent must be a folder")
				return
			}
			if !s.itemView(principal, parent).CanCreateChild {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "target parent or ancestor permission denied")
				return
			}
			if s.isDescendantOf(id, target) {
				writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "cannot move into a descendant")
				return
			}
		}
		newParentID = target
	}

	if s.hasNameConflict(newParentID, newName, id) {
		writeAPIError(w, http.StatusConflict, "NAME_CONFLICT", "a resource with that name already exists in the target directory")
		return
	}

	if newParentID != item.ParentID {
		for _, descendantID := range s.collectSubtree(id) {
			descendant := s.state.Resources[descendantID]
			if !fileTypes[descendant.Type] || !s.itemView(principal, descendant).CanWrite {
				writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "subtree permission denied")
				return
			}
		}
	}

	item = cloneDirectoryItem(item)
	item.Name = newName
	item.ParentID = newParentID
	if input.Meta != nil {
		for _, key := range []string{"personalOwner", "systemLocation", "originalParentId", "trashedAt"} {
			delete(input.Meta, key)
		}
		if item.Type == "file" {
			for _, key := range []string{"contentHash", "size", "mimeType", "uploadId"} {
				delete(input.Meta, key)
			}
		}
		if item.Meta == nil {
			item.Meta = make(map[string]interface{})
		}
		for k, v := range input.Meta {
			item.Meta[k] = v
		}
	}
	if input.ACL != nil {
		// Ownership is server-managed, including the ACL's owner field.
		input.ACL.OwnerID = item.ACL.OwnerID
		item.ACL = *input.ACL
	}
	item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	candidate := s.directoryCandidateLocked()
	candidate.Resources[id] = item
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist resource")
		return
	}
	s.directoryChangedLocked()
	s.recordMutationLocked("resource.update", principal, id, item.Name)

	writeJSON(w, http.StatusOK, s.itemView(principal, item))
}

func (s *mvpStore) handleFilesDelete(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	if !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
		return
	}

	recursive := strings.TrimSpace(r.URL.Query().Get("recursive")) == "true"

	s.mu.Lock()
	defer s.mu.Unlock()

	item, exists := s.state.Resources[id]
	if !exists {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	if !s.itemView(principal, item).CanWrite {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource, source parent or ancestor permission denied")
		return
	}

	children := s.countChildren(id)
	if children > 0 && !recursive {
		writeAPIError(w, http.StatusConflict, "NOT_EMPTY", "directory is not empty; use recursive=true to delete with contents")
		return
	}

	toDelete := []string{id}
	if recursive && children > 0 {
		toDelete = s.collectSubtree(id)
	}
	// Authorize the entire subtree before deleting anything.
	for _, delID := range toDelete {
		descendant := s.state.Resources[delID]
		if !fileTypes[descendant.Type] || !s.itemView(principal, descendant).CanWrite {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "subtree permission denied")
			return
		}
	}

	candidate := s.directoryCandidateLocked()
	deleted := make(map[string]bool, len(toDelete))
	for _, delID := range toDelete {
		delete(candidate.Resources, delID)
		deleted[delID] = true
	}
	for token, share := range candidate.Shares {
		if deleted[share.ResourceID] {
			delete(candidate.Shares, token)
		}
	}
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist resource deletion")
		return
	}
	s.directoryChangedLocked()
	s.recordMutationLocked("resource.delete", principal, id, item.Name)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
}

func (s *mvpStore) handleLegacyListResources(w http.ResponseWriter, r *http.Request, principal authPrincipal) {
	type resourcePage struct {
		Items      []protocol.ResourceRecord `json:"items"`
		NextCursor string                    `json:"nextCursor,omitempty"`
	}
	type resourceFilter struct{ Type, ParentID string }
	filter := resourceFilter{
		Type:     strings.TrimSpace(r.URL.Query().Get("type")),
		ParentID: strings.TrimSpace(r.URL.Query().Get("parentId")),
	}
	s.mu.RLock()
	items := make([]protocol.ResourceRecord, 0, len(s.state.Resources))
	for _, item := range s.state.Resources {
		var readable bool
		if fileTypes[item.Type] {
			readable = s.itemView(principal, item).CanRead
		} else {
			readable = resourceAllows(principal, item, "resource.read")
		}
		if filter.Type != "" && item.Type != filter.Type || filter.ParentID != "" && item.ParentID != filter.ParentID || !readable {
			continue
		}
		items = append(items, item)
	}
	s.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt < items[j].UpdatedAt })
	start := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("cursor")); err == nil && n >= 0 {
		start = n
	}
	limit := parseLimit(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	if start > len(items) {
		start = len(items)
	}
	end := minInt(start+limit, len(items))
	next := ""
	if end < len(items) {
		next = strconv.Itoa(end)
	}
	writeJSON(w, http.StatusOK, resourcePage{Items: items[start:end], NextCursor: next})
}

func (s *mvpStore) handleLegacyResourceItem(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	if r.Method != http.MethodGet && r.Method != http.MethodPatch {
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	var input struct {
		Name string                 `json:"name"`
		Meta map[string]interface{} `json:"meta"`
		ACL  *protocol.ResourceACL  `json:"acl"`
	}
	if r.Method == http.MethodPatch && json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&input) != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid resource update")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	item, exists := s.state.Resources[id]
	if !exists {
		writeAPIError(w, http.StatusNotFound, "INVALID_REQUEST", "resource not found")
		return
	}
	if !roleAllows(principal.Role, "resource.read") || !resourceAllows(principal, item, "resource.read") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.read permission required")
		return
	}
	item = cloneDirectoryItem(item)
	if r.Method == http.MethodPatch {
		if !roleAllows(principal.Role, "resource.write") || !resourceAllows(principal, item, "resource.write") {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
			return
		}
		if input.Name != "" {
			item.Name = strings.TrimSpace(input.Name)
		}
		if input.Meta != nil {
			item.Meta = input.Meta
		}
		if input.ACL != nil {
			input.ACL.OwnerID = item.ACL.OwnerID
			item.ACL = *input.ACL
		}
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	} else {
		item.LastAccessedAt = time.Now().UTC().Format(time.RFC3339)
	}
	candidate := s.directoryCandidateLocked()
	candidate.Resources[id] = item
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist resource")
		return
	}
	if r.Method == http.MethodPatch {
		s.directoryChangedLocked()
		s.recordMutationLocked("resource.update", principal, id, item.Name)
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *mvpStore) handleResourceShare(w http.ResponseWriter, r *http.Request, id string, principal authPrincipal) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	item, exists := s.state.Resources[id]
	if !exists {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	var canWrite bool
	if fileTypes[item.Type] {
		canWrite = s.itemView(principal, item).CanWrite
	} else {
		canWrite = resourceAllows(principal, item, "resource.write")
	}
	if !canWrite {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.write permission required")
		return
	}
	var input struct {
		TTLSeconds int `json:"ttlSeconds"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 8*1024)).Decode(&input)
	if input.TTLSeconds <= 0 || input.TTLSeconds > 24*60*60 {
		input.TTLSeconds = 15 * 60
	}
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create share link")
		return
	}
	now := time.Now().UTC()
	share := protocol.ResourceShareLink{
		Token:      base64.RawURLEncoding.EncodeToString(random[:]),
		ResourceID: id,
		ExpiresAt:  now.Add(time.Duration(input.TTLSeconds) * time.Second).Format(time.RFC3339),
		SingleUse:  true,
		CreatedBy:  principal.UserID,
		CreatedAt:  now.Format(time.RFC3339),
	}
	candidate := s.directoryCandidateLocked()
	candidate.Shares[share.Token] = share
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not persist share")
		return
	}
	s.directoryChangedLocked()
	s.recordMutationLocked("resource.share.create", principal, id, share.ExpiresAt)
	writeJSON(w, http.StatusCreated, share)
}

func (s *mvpStore) recordMutationLocked(action string, principal authPrincipal, target, detail string) {
	if s.audit == nil {
		return
	}
	s.audit.record(auditEntry{
		ActorUserID: principal.UserID,
		ActorName:   principal.DisplayName,
		Action:      action,
		Target:      target,
		Detail:      redactSecrets(detail),
	})
}

// Retained for directoryCommitter compatibility. The old signature cannot carry
// an authenticated principal or the upload transaction backend, so it fails closed.
func (s *mvpStore) commitUploadEntry(session *uploadSession, contentHash string) (string, string, error) {
	return "", "", fmt.Errorf("authenticated atomic directory completion required")
}

func (s *mvpStore) validateUploadTarget(principal authPrincipal, parentID string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.validateUploadTargetLocked(principal, parentID)
}

func (s *mvpStore) validateUploadTargetLocked(principal authPrincipal, parentID string) error {
	if principal.Status != accessStatusActive || principal.UserID == "" || principal.WorkspaceID != "demo" || !roleAllows(principal.Role, "resource.write") {
		return errUploadForbidden
	}
	if parentID == "" {
		return nil
	}
	parent, exists := s.state.Resources[parentID]
	if !exists {
		return errUploadTargetNotFound
	}
	if parent.Type != "folder" {
		return errUploadTargetInvalid
	}
	if !s.itemView(principal, parent).CanCreateChild {
		return errUploadForbidden
	}
	return nil
}

// Lock order is uploads -> MVP -> backend. Never call back into uploadStore.
func (s *mvpStore) completeUploadEntry(principal authPrincipal, snapshot uploadSession, backend persistBackend) (uploadSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if principal.Status != accessStatusActive || principal.UserID == "" || principal.WorkspaceID != "demo" ||
		!roleAllows(principal.Role, "resource.write") || snapshot.ownerID != principal.UserID || snapshot.workspaceID != principal.WorkspaceID {
		return snapshot, errUploadForbidden
	}
	if snapshot.status == "completed" {
		existing, ok := s.state.Resources[snapshot.entryID]
		if !ok {
			return snapshot, errUploadEntryNotFound
		}
		if existing.Type != "file" || existing.OwnerID != snapshot.ownerID || existing.WorkspaceID != snapshot.workspaceID ||
			existing.Meta["uploadId"] != snapshot.id || existing.Meta["contentHash"] != snapshot.contentHash || !s.itemView(principal, existing).CanRead {
			return snapshot, errUploadForbidden
		}
		snapshot.name = existing.Name
		return snapshot, nil
	}
	if err := s.validateUploadTargetLocked(principal, snapshot.parentID); err != nil {
		return snapshot, err
	}
	if snapshot.status != "verifying" || snapshot.entryID == "" || snapshot.id == "" || !isDigest(snapshot.contentHash) || backend == nil {
		return snapshot, fmt.Errorf("invalid verified upload snapshot")
	}
	if _, exists := s.state.Resources[snapshot.entryID]; exists {
		return snapshot, errUploadForbidden
	}
	name, err := validateResourceName(snapshot.name)
	if err != nil {
		return snapshot, err
	}
	snapshot.name = generateAutoName(s, snapshot.parentID, name, "")
	snapshot.status = "completed"
	now := time.Now().UTC().Format(time.RFC3339)
	item := protocol.ResourceRecord{
		ID: snapshot.entryID, WorkspaceID: snapshot.workspaceID, Type: "file",
		Name: snapshot.name, ParentID: snapshot.parentID, OwnerID: snapshot.ownerID,
		ACL: defaultFileACL(snapshot.ownerID),
		Meta: map[string]interface{}{
			"contentHash": snapshot.contentHash, "size": float64(snapshot.size),
			"mimeType": snapshot.mimeType, "uploadId": snapshot.id,
		},
		CreatedAt: now, UpdatedAt: now,
	}
	candidate := s.directoryCandidateLocked()
	candidate.Resources[item.ID] = item
	raw, err := json.Marshal(candidate)
	if err != nil {
		return snapshot, err
	}
	if err := backend.saveUploadWithMVPState(snapshot, raw); err != nil {
		return snapshot, err
	}
	s.state = candidate
	s.directoryChangedLocked()
	return snapshot, nil
}

func generateAutoName(s *mvpStore, parentID, name, excludeID string) string {
	if !s.hasNameConflict(parentID, name, excludeID) {
		return name
	}
	dotIdx := strings.LastIndex(name, ".")
	base, ext := name, ""
	if dotIdx > 0 {
		base = name[:dotIdx]
		ext = name[dotIdx:]
	}
	for i := 2; i < 10000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !s.hasNameConflict(parentID, candidate, excludeID) {
			return candidate
		}
	}
	return fmt.Sprintf("%s_%d%s", base, time.Now().UnixNano(), ext)
}

func (s *mvpStore) handleAuthorizedDownload(w http.ResponseWriter, r *http.Request) {
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

	principal, authenticated := principalForRequest(s.authFromHub(), r)
	if !authenticated || principal.Status != accessStatusActive || principal.WorkspaceID != "demo" || !roleAllows(principal.Role, "resource.read") {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource.read permission required")
		return
	}

	// Resolve identity and all ancestor ACLs against one locked state snapshot.
	s.mu.RLock()
	contentHash, hashRequest := strings.CutPrefix(resourceID, "sha256:")
	if hashRequest {
		if !isDigest(contentHash) {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "file not found")
			return
		}
		if !s.readableContentHashLocked(principal, contentHash) {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "file permission denied")
			return
		}
	} else {
		item, exists := s.state.Resources[resourceID]
		if !exists || item.Type != "file" {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "file not found")
			return
		}
		if !s.itemView(principal, item).CanRead {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "resource or ancestor permission denied")
			return
		}
		contentHash, _ = item.Meta["contentHash"].(string)
	}
	s.mu.RUnlock()
	if !isDigest(contentHash) || s.content == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "file has no content")
		return
	}

	r.URL.Path = "/api/v1/files/sha256:" + contentHash + "/content"
	s.content.handleDownload(w, r)
}

func (s *mvpStore) readableContentHashLocked(principal authPrincipal, hash string) bool {
	if s.state.LegacyReadableHashes[hash] {
		return true
	}
	for _, item := range s.state.Resources {
		if item.Type == "file" && item.Meta["contentHash"] == hash && s.itemView(principal, item).CanRead {
			return true
		}
	}
	for _, artifact := range s.state.Artifacts {
		if artifact.ContentHash != hash || artifact.ResourceID != "sha256:"+hash {
			continue
		}
		job, exists := s.state.Jobs[artifact.JobID]
		if !exists {
			continue
		}
		project, exists := s.state.Resources[job.Spec.ProjectID]
		if exists && project.Type == "code.project" && roleAllows(principal.Role, "code.read") && fileResourceAllows(principal, project, "resource.read") {
			return true
		}
	}
	return false
}
