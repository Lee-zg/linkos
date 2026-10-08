package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

type filePreferences struct {
	DownloadsID     string `json:"downloadsId"`
	InboxID         string `json:"inboxId"`
	TrashID         string `json:"trashId"`
	OutgoingID      string `json:"outgoingId"`
	ReceiveFolderID string `json:"receiveFolderId"`
}

// Personal locations are server-managed. They share CAS bytes, never ACLs.
func (s *mvpStore) personalCandidateLocked(principal authPrincipal) (mvpState, filePreferences) {
	return personalLocations(s.directoryCandidateLocked(), principal)
}

func personalLocations(candidate mvpState, principal authPrincipal) (mvpState, filePreferences) {
	previous := candidate.FilePreferences
	candidate.FilePreferences = make(map[string]filePreferences, len(previous)+1)
	for id, pref := range previous {
		candidate.FilePreferences[id] = pref
	}
	pref := candidate.FilePreferences[principal.UserID]
	root := fmt.Sprintf("personal_%x", sha256.Sum256([]byte(principal.WorkspaceID+":"+principal.UserID)))
	now := time.Now().UTC().Format(time.RFC3339)
	locations := []struct {
		suffix, name string
		target       *string
	}{
		{"downloads", "Downloads", &pref.DownloadsID}, {"inbox", "个人文件", &pref.InboxID},
		{"trash", "废纸篓", &pref.TrashID}, {"outgoing", "聊天附件", &pref.OutgoingID},
	}
	for _, location := range locations {
		id := root + "_" + location.suffix
		*location.target = id
		if _, exists := candidate.Resources[id]; !exists {
			candidate.Resources[id] = protocol.ResourceRecord{ID: id, WorkspaceID: principal.WorkspaceID, Type: "folder", Name: location.name, OwnerID: principal.UserID,
				ACL: protocol.ResourceACL{OwnerID: principal.UserID}, Meta: map[string]interface{}{"personalOwner": principal.UserID, "systemLocation": location.suffix}, CreatedAt: now, UpdatedAt: now}
		}
	}
	if pref.ReceiveFolderID == "" {
		pref.ReceiveFolderID = pref.DownloadsID
	}
	candidate.FilePreferences[principal.UserID] = pref
	return candidate, pref
}

func (s *mvpStore) handleFilePreferences(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPatch {
		writeAPIError(w, 405, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	var input struct {
		ReceiveFolderID string `json:"receiveFolderId"`
	}
	if r.Method == http.MethodPatch && json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil {
		writeAPIError(w, 400, "INVALID_REQUEST", "invalid folder")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == http.MethodGet {
		if pref, exists := s.state.FilePreferences[principal.UserID]; exists && s.state.Resources[pref.DownloadsID].ID != "" && s.state.Resources[pref.InboxID].ID != "" && s.state.Resources[pref.TrashID].ID != "" && s.state.Resources[pref.OutgoingID].ID != "" {
			writeJSON(w, 200, pref)
			return
		}
	}
	candidate, pref := s.personalCandidateLocked(principal)
	if r.Method == http.MethodPatch {
		target := input.ReceiveFolderID
		if target == "" {
			target = pref.DownloadsID
		}
		item, exists := candidate.Resources[target]
		if !exists || item.Type != "folder" || target == pref.TrashID || s.isDescendantOf(pref.TrashID, target) {
			writeAPIError(w, 400, "INVALID_REQUEST", "choose a writable folder outside Trash")
			return
		}
		if target != pref.DownloadsID && !s.itemView(principal, item).CanCreateChild {
			writeAPIError(w, 403, "FORBIDDEN", "folder is not writable")
			return
		}
		pref.ReceiveFolderID = target
		candidate.FilePreferences[principal.UserID] = pref
	}
	created := len(candidate.Resources) != len(s.state.Resources)
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, 500, "INTERNAL_ERROR", "could not save file preferences")
		return
	}
	if created {
		s.directoryChangedLocked()
	}
	writeJSON(w, 200, pref)
}

func candidateName(resources map[string]protocol.ResourceRecord, parent, name string) string {
	available := func(value string) bool {
		for _, item := range resources {
			if fileTypes[item.Type] && item.ParentID == parent && strings.EqualFold(item.Name, value) {
				return false
			}
		}
		return true
	}
	if available(name) {
		return name
	}
	base, ext := name, ""
	if dot := strings.LastIndex(name, "."); dot > 0 {
		base, ext = name[:dot], name[dot:]
	}
	for n := 2; ; n++ {
		suffix := fmt.Sprintf(" (%d)%s", n, ext)
		if len(suffix) > 200 {
			ext = ""
			suffix = fmt.Sprintf(" (%d)", n)
		}
		runes := []rune(base)
		for len(string(runes))+len(suffix) > 255 {
			runes = runes[:len(runes)-1]
		}
		value := string(runes) + suffix
		if available(value) {
			return value
		}
	}
}

func (s *mvpStore) handleFileOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	var input struct {
		Action   string   `json:"action"`
		IDs      []string `json:"ids"`
		ParentID string   `json:"parentId"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 32768)).Decode(&input) != nil || len(input.IDs) == 0 || len(input.IDs) > 100 {
		writeAPIError(w, 400, "INVALID_REQUEST", "select 1 to 100 items")
		return
	}
	if input.Action != "copy" && input.Action != "move" && input.Action != "trash" && input.Action != "restore" {
		writeAPIError(w, 400, "INVALID_REQUEST", "unknown operation")
		return
	}
	if !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, 403, "FORBIDDEN", "write permission required")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate, pref := s.personalCandidateLocked(principal)
	selected := map[string]bool{}
	for _, id := range input.IDs {
		selected[id] = true
	}
	roots := []string{}
	for _, id := range input.IDs {
		item, exists := s.state.Resources[id]
		if !exists || !fileTypes[item.Type] {
			writeAPIError(w, 404, "NOT_FOUND", "item not found")
			return
		}
		if item.Meta["systemLocation"] != nil {
			writeAPIError(w, 403, "FORBIDDEN", "system locations cannot be changed")
			return
		}
		nested := false
		for parent := item.ParentID; parent != ""; parent = s.state.Resources[parent].ParentID {
			if selected[parent] {
				nested = true
				break
			}
		}
		if !nested {
			roots = append(roots, id)
		}
	}
	seen := map[string]bool{}
	changed := []protocol.ResourceRecord{}
	now := time.Now().UTC().Format(time.RFC3339)
	totalEntries := 0
	for _, id := range roots {
		if seen[id] {
			continue
		}
		seen[id] = true
		item := cloneDirectoryItem(s.state.Resources[id])
		target := input.ParentID
		if input.Action == "trash" {
			target = pref.TrashID
		}
		if input.Action == "restore" {
			if item.ParentID != pref.TrashID {
				writeAPIError(w, 400, "INVALID_REQUEST", "item is not in Trash")
				return
			}
			target, _ = item.Meta["originalParentId"].(string)
		}
		if target == id || s.isDescendantOf(id, target) {
			writeAPIError(w, 400, "INVALID_REQUEST", "cannot place a folder inside itself")
			return
		}
		if target != "" {
			parent, exists := candidate.Resources[target]
			if !exists || parent.Type != "folder" {
				writeAPIError(w, 409, "DESTINATION_MISSING", "original folder no longer exists; move the item to another folder")
				return
			}
			if target != pref.TrashID && !s.itemView(principal, parent).CanCreateChild {
				writeAPIError(w, 403, "FORBIDDEN", "destination is not writable")
				return
			}
		}
		subtree := s.collectSubtree(id)
		totalEntries += len(subtree)
		if totalEntries > 2000 {
			writeAPIError(w, 413, "INVALID_REQUEST", "operation limited to 2000 entries")
			return
		}
		for _, childID := range subtree {
			child := s.state.Resources[childID]
			view := s.itemView(principal, child)
			if !fileTypes[child.Type] || !view.CanRead || input.Action != "copy" && !view.CanWrite {
				writeAPIError(w, 403, "FORBIDDEN", "subtree permission denied")
				return
			}
		}
		if input.Action == "copy" {
			mapped := map[string]string{}
			for _, childID := range subtree {
				child := cloneDirectoryItem(s.state.Resources[childID])
				candidate.NextSeq++
				child.ID = fmt.Sprintf("entry_copy_%d", candidate.NextSeq)
				mapped[childID] = child.ID
				if childID == id {
					child.ParentID = target
					child.Name = candidateName(candidate.Resources, target, child.Name)
				} else {
					child.ParentID = mapped[child.ParentID]
				}
				child.OwnerID = principal.UserID
				child.ACL = defaultFileACL(principal.UserID)
				child.CreatedAt = now
				child.UpdatedAt = now
				delete(child.Meta, "originalParentId")
				delete(child.Meta, "trashedAt")
				candidate.Resources[child.ID] = child
				if childID == id {
					changed = append(changed, child)
				}
			}
		} else {
			if input.Action == "trash" {
				if item.ParentID == pref.TrashID {
					continue
				}
				if item.Meta == nil {
					item.Meta = map[string]interface{}{}
				}
				item.Meta["originalParentId"] = item.ParentID
				item.Meta["trashedAt"] = now
			}
			if input.Action == "restore" {
				delete(item.Meta, "originalParentId")
				delete(item.Meta, "trashedAt")
			}
			delete(candidate.Resources, id)
			item.Name = candidateName(candidate.Resources, target, item.Name)
			item.ParentID = target
			item.UpdatedAt = now
			candidate.Resources[id] = item
			changed = append(changed, item)
		}
	}
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, 500, "INTERNAL_ERROR", "operation could not be saved")
		return
	}
	s.directoryChangedLocked()
	s.recordMutationLocked("resource."+input.Action, principal, strings.Join(input.IDs, ","), "")
	writeJSON(w, 200, map[string]interface{}{"items": changed})
}
