package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func (s *mvpStore) handleChatMembers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, 405, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	items := []map[string]string{}
	if auth := s.authFromHub(); auth != nil {
		for _, member := range auth.listMembers() {
			if member.Status == accessStatusActive {
				items = append(items, map[string]string{"userId": member.UserID, "displayName": member.DisplayName})
			}
		}
	}
	writeJSON(w, 200, map[string]interface{}{"items": items})
}

func (s *mvpStore) prepareBlocksLocked(principal authPrincipal, blocks []protocol.MessageBlock) ([]protocol.MessageBlock, error) {
	if len(blocks) > 16 {
		return nil, fmt.Errorf("at most 16 attachments per message")
	}
	result := make([]protocol.MessageBlock, 0, len(blocks))
	for _, block := range blocks {
		switch block.Type {
		case "file.reference":
			id, _ := block.Value["resourceId"].(string)
			item, exists := s.state.Resources[id]
			if !exists || item.Type != "file" || !s.itemView(principal, item).CanRead {
				return nil, fmt.Errorf("attachment is not readable")
			}
			hash, _ := item.Meta["contentHash"].(string)
			if !isDigest(hash) {
				return nil, fmt.Errorf("attachment content is unavailable")
			}
			// Never trust client-supplied hashes, sizes, names or receipt IDs.
			block.Value = map[string]interface{}{"resourceId": id, "name": item.Name, "size": item.Meta["size"], "mimeType": item.Meta["mimeType"], "contentHash": hash}
		case "code.snippet":
			content, _ := block.Value["content"].(string)
			language, _ := block.Value["language"].(string)
			if strings.TrimSpace(content) == "" || len(content) > 65536 || len(language) > 40 {
				return nil, fmt.Errorf("code must contain 1 to 65536 bytes")
			}
			block.Value = map[string]interface{}{"content": content, "language": language}
		case "code.reference":
			id, _ := block.Value["resourceId"].(string)
			item, exists := s.state.Resources[id]
			if !exists || !roleAllows(principal.Role, "code.read") || !resourceAllows(principal, item, "resource.read") {
				return nil, fmt.Errorf("code is not readable")
			}
			file, exists := s.state.CodeFiles[id]
			if !exists {
				return nil, fmt.Errorf("code file not found")
			}
			content := s.state.CodeData[id]
			if len(content) > 65536 {
				return nil, fmt.Errorf("code reference exceeds 64 KiB")
			}
			block.Type = "code.snippet"
			block.Value = map[string]interface{}{"content": content, "language": file.Language}
		case "text", "run.result":
			// Legacy blocks remain inert, bounded JSON in the renderer.
		default:
			return nil, fmt.Errorf("unsupported message block")
		}
		result = append(result, block)
	}
	return result, nil
}

func (s *mvpStore) handleComposeMessage(w http.ResponseWriter, r *http.Request) {
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !roleAllows(principal.Role, "chat.send") {
		writeAPIError(w, 403, "FORBIDDEN", "chat.send permission required")
		return
	}
	var input protocol.MessageCreateInput
	if json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&input) != nil || input.ChannelID == "" || strings.TrimSpace(input.Body) == "" && len(input.Blocks) == 0 || len(input.Body) > 65536 || len(input.ClientMsgID) > 200 {
		writeAPIError(w, 400, "INVALID_REQUEST", "message requires text or attachments and a channel")
		return
	}
	// Resolve members before the directory mutex: auth and resource locks never nest.
	recipients := []authPrincipal{}
	if auth := s.authFromHub(); auth != nil {
		for _, member := range auth.listMembers() {
			if member.Status == accessStatusActive {
				recipients = append(recipients, authPrincipal{UserID: member.UserID, Role: member.Role, WorkspaceID: principal.WorkspaceID})
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	channel, exists := s.state.Channels[input.ChannelID]
	if !exists {
		writeAPIError(w, 404, "NOT_FOUND", "channel not found")
		return
	}
	if !channelAllows(principal, channel) {
		writeAPIError(w, 403, "FORBIDDEN", "channel membership required")
		return
	}
	if input.ClientMsgID != "" {
		for _, message := range s.state.Messages {
			if message.AuthorID == principal.UserID && message.ChannelID == input.ChannelID && message.ClientMsgID == input.ClientMsgID {
				writeJSON(w, 200, protocol.AcceptedMessage{MessageID: message.ID, ServerMsgID: message.ID, Status: "duplicate"})
				return
			}
		}
	}
	if input.ThreadID != "" {
		root, ok := s.state.Messages[input.ThreadID]
		if !ok || root.ChannelID != input.ChannelID || root.DeletedAt != "" {
			writeAPIError(w, 400, "INVALID_REQUEST", "invalid thread")
			return
		}
	}
	blocks, err := s.prepareBlocksLocked(principal, input.Blocks)
	if err != nil {
		writeAPIError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	candidate := s.directoryCandidateLocked()
	candidate.NextSeq++
	message := protocol.ChatMessage{ID: fmt.Sprintf("message_%d", candidate.NextSeq), ChannelID: input.ChannelID, ThreadID: input.ThreadID, AuthorID: principal.UserID, AuthorName: principal.DisplayName, Body: input.Body, Blocks: blocks, Mentions: input.Mentions, ClientMsgID: input.ClientMsgID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Version: 1}
	candidate.Messages = make(map[string]protocol.ChatMessage, len(s.state.Messages)+1)
	for id, item := range s.state.Messages {
		candidate.Messages[id] = item
	}
	candidate.Messages[message.ID] = message
	for _, recipient := range recipients {
		if recipient.UserID != principal.UserID && channelAllows(recipient, channel) && roleAllows(recipient.Role, "resource.write") {
			candidate, _ = s.receiveIntoCandidate(candidate, recipient, message)
		}
	}
	if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
		writeAPIError(w, 500, "INTERNAL_ERROR", "message could not be saved")
		return
	}
	if durable, ok := s.backend.(mvpFTSBackend); ok {
		_ = durable.indexMVPMessage(message)
	}
	// Events carry invalidation only. Private messages/attachments are read through authenticated APIs.
	event := s.hub.emit("chat.message.created", map[string]string{"messageId": message.ID})
	if len(blocks) > 0 {
		s.directoryChangedLocked()
	}
	s.recordMutationLocked("message.create", principal, message.ID, input.ChannelID)
	writeJSON(w, 201, protocol.AcceptedMessage{MessageID: message.ID, ServerMsgID: message.ID, Seq: event.Seq, Status: "accepted"})
}

func (s *mvpStore) receiveIntoCandidate(candidate mvpState, principal authPrincipal, message protocol.ChatMessage) (mvpState, []string) {
	key := principal.UserID + ":" + message.ID
	if ids, exists := candidate.MessageReceipts[key]; exists {
		return candidate, ids
	}
	hasFiles := false
	for _, block := range message.Blocks {
		if block.Type == "file.reference" {
			hasFiles = true
		}
	}
	if !hasFiles {
		return candidate, []string{}
	}
	var pref filePreferences
	candidate, pref = personalLocations(candidate, principal)
	target := pref.ReceiveFolderID
	// A removed/revoked custom folder falls back to the private Downloads location.
	if target != pref.DownloadsID {
		folder, exists := s.state.Resources[target]
		if !exists || !s.itemView(principal, folder).CanCreateChild || s.isDescendantOf(pref.TrashID, target) {
			target = pref.DownloadsID
		}
	}
	ids := []string{}
	for _, block := range message.Blocks {
		if block.Type != "file.reference" {
			continue
		}
		hash, _ := block.Value["contentHash"].(string)
		if !isDigest(hash) {
			continue
		}
		name, _ := block.Value["name"].(string)
		if _, err := validateResourceName(name); err != nil {
			continue
		}
		candidate.NextSeq++
		id := fmt.Sprintf("received_%d", candidate.NextSeq)
		now := time.Now().UTC().Format(time.RFC3339)
		candidate.Resources[id] = protocol.ResourceRecord{ID: id, WorkspaceID: principal.WorkspaceID, Type: "file", Name: candidateName(candidate.Resources, target, name), ParentID: target, OwnerID: principal.UserID, ACL: protocol.ResourceACL{OwnerID: principal.UserID}, Meta: map[string]interface{}{"contentHash": hash, "size": block.Value["size"], "mimeType": block.Value["mimeType"], "messageId": message.ID}, CreatedAt: now, UpdatedAt: now}
		ids = append(ids, id)
	}
	receipts := make(map[string][]string, len(candidate.MessageReceipts)+1)
	for id, values := range candidate.MessageReceipts {
		receipts[id] = values
	}
	receipts[key] = ids
	candidate.MessageReceipts = receipts
	return candidate, ids
}

func (s *mvpStore) handleChatReceipt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !roleAllows(principal.Role, "resource.write") {
		writeAPIError(w, 403, "FORBIDDEN", "write permission required")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/chat-receipts/")
	s.mu.Lock()
	defer s.mu.Unlock()
	message, exists := s.state.Messages[id]
	channel, channelExists := s.state.Channels[message.ChannelID]
	if !exists || message.DeletedAt != "" {
		writeAPIError(w, 404, "NOT_FOUND", "message not found")
		return
	}
	if !channelExists || !channelAllows(principal, channel) {
		writeAPIError(w, 403, "FORBIDDEN", "channel membership required")
		return
	}
	ids, received := s.state.MessageReceipts[principal.UserID+":"+message.ID]
	if !received {
		candidate, receiptIDs := s.receiveIntoCandidate(s.directoryCandidateLocked(), principal, message)
		if err := s.saveDirectoryCandidateLocked(candidate); err != nil {
			writeAPIError(w, 500, "INTERNAL_ERROR", "could not receive attachment")
			return
		}
		ids = receiptIDs
		if len(ids) > 0 {
			s.directoryChangedLocked()
		}
	}
	items := []fileItemView{}
	for _, entryID := range ids {
		if item, ok := s.state.Resources[entryID]; ok && s.itemView(principal, item).CanRead {
			items = append(items, s.itemView(principal, item))
		}
	}
	writeJSON(w, 200, map[string]interface{}{"items": items})
}
