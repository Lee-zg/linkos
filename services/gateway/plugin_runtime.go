package main

import (
	"encoding/json"
	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

func (s *mvpStore) issuePluginTicket(w http.ResponseWriter, r *http.Request, id string) {
	principal, _ := principalForRequest(s.authFromHub(), r)
	var input struct {
		StageID string `json:"stageId"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil {
		writeAPIError(w, 400, "INVALID_REQUEST", "需要有效票据请求")
		return
	}
	var rec protocol.PluginRecord
	if input.StageID != "" {
		if !roleAllows(principal.Role, "plugin.install") {
			writeAPIError(w, 403, "FORBIDDEN", "只有管理员可验证安装候选")
			return
		}
		p := s.pluginRuntime
		p.mu.Lock()
		stage := p.stages[input.StageID]
		if stage == nil || stage.token != principal.Token || stage.Manifest.ID != id || time.Now().After(stage.ExpiresAt) {
			p.mu.Unlock()
			writeAPIError(w, 409, "PLUGIN_STAGE_EXPIRED", "候选包已过期")
			return
		}
		rec = protocol.PluginRecord{ID: id, Version: stage.Manifest.Version, Manifest: stage.Manifest, Source: "package", Runtime: "iframe", ArtifactDigest: stage.Digest}
		p.mu.Unlock()
	} else {
		s.mu.RLock()
		item, ok := s.state.Plugins[id]
		s.mu.RUnlock()
		rec = item
		if !ok {
			writeAPIError(w, 404, "PLUGIN_NOT_FOUND", "插件不存在")
			return
		}
		if rec.Status != "enabled" {
			writeAPIError(w, 409, "PLUGIN_DISABLED", "应用尚未启用")
			return
		}
		if rec.Source == "builtin" {
			writeAPIError(w, 409, "PLUGIN_BUILTIN_MANAGED", "官方应用使用原生窗口")
			return
		}
		if err := s.verifyPluginResources(rec); err != nil {
			writePluginError(w, err)
			return
		}
	}
	nonce := randomSecret()
	expires := time.Now().Add(15 * time.Minute)
	p := s.pluginRuntime
	p.mu.Lock()
	p.tickets[nonce] = pluginTicket{record: rec, stageID: input.StageID, token: principal.Token, expires: expires, origin: pluginRequestOrigin(r)}
	p.mu.Unlock()
	writeJSON(w, 200, map[string]interface{}{"nonce": nonce, "protocol": "1.0", "expiresAt": expires, "src": "/api/v1/plugin-views/" + nonce + "/" + rec.Manifest.Entry["ui"]})
}
func (s *mvpStore) validTicket(nonce string) (pluginTicket, bool) {
	p := s.pluginRuntime
	p.mu.Lock()
	ticket, ok := p.tickets[nonce]
	stage := p.stages[ticket.stageID]
	p.mu.Unlock()
	if !ok || time.Now().After(ticket.expires) {
		return ticket, false
	}
	request, _ := http.NewRequest("GET", "/", nil)
	request.Header.Set("Authorization", "Bearer "+ticket.token)
	principal, ok := principalForRequest(s.authFromHub(), request)
	if !ok || principal.Status != accessStatusActive {
		return ticket, false
	}
	if ticket.stageID != "" {
		return ticket, stage != nil && time.Now().Before(stage.ExpiresAt)
	}
	s.mu.RLock()
	rec := s.state.Plugins[ticket.record.ID]
	s.mu.RUnlock()
	return ticket, rec.Status == "enabled" && rec.Revision == ticket.record.Revision && rec.ArtifactDigest == ticket.record.ArtifactDigest
}
func (s *mvpStore) handlePluginView(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/v1/plugin-views/"), "/", 2)
	if len(parts) != 2 {
		writeAPIError(w, 404, "PLUGIN_TICKET_INVALID", "沙箱票据无效")
		return
	}
	ticket, ok := s.validTicket(parts[0])
	if !ok {
		writeAPIError(w, 403, "PLUGIN_TICKET_INVALID", "沙箱票据已过期或应用状态已变化")
		return
	}
	name := parts[1]
	if !validPluginAssetPath(name) || !strings.HasPrefix(name, "ui/") {
		writeAPIError(w, 404, "PLUGIN_RESOURCE_INVALID", "只能读取该版本的 UI 资源")
		return
	}
	var data []byte
	var err error
	if ticket.stageID != "" {
		p := s.pluginRuntime
		p.mu.Lock()
		stage := p.stages[ticket.stageID]
		if stage != nil {
			data, err = readVerifiedPluginAsset(stage.directory, stage.Digest, name)
		}
		p.mu.Unlock()
	} else {
		data, err = s.readManagedPluginAsset(ticket.record, name)
	}
	if err != nil || data == nil {
		if _, ok := err.(*pluginError); ok {
			writePluginError(w, err)
			return
		}
		writeAPIError(w, 404, "PLUGIN_RESOURCE_MISSING", "插件资源加载失败")
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "null")
	base := ticket.origin + "/api/v1/plugin-views/" + parts[0] + "/ui/"
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src "+base+" 'unsafe-inline'; style-src "+base+" 'unsafe-inline'; img-src "+base+" data:; font-src "+base+"; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Type", guessContentType(name))
	if r.Method == "GET" {
		w.Write(data)
	}
}

// Preserve the browser-facing origin through the Vite proxy. The configured
// public scheme also covers TLS termination at the deployment proxy.
func pluginRequestOrigin(r *http.Request) string {
	if origin, err := url.Parse(r.Header.Get("Origin")); err == nil && (origin.Scheme == "http" || origin.Scheme == "https") && origin.Host != "" && origin.Path == "" {
		return origin.Scheme + "://" + origin.Host
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if public, err := url.Parse(activeConfig.PublicURL); err == nil && public.Host == r.Host {
		scheme = public.Scheme
	}
	return scheme + "://" + r.Host
}
func (s *mvpStore) authenticatedPluginContent(w http.ResponseWriter, r *http.Request, id, name string) {
	if r.Method != "GET" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	s.mu.RLock()
	rec, ok := s.state.Plugins[id]
	s.mu.RUnlock()
	if !ok {
		writeAPIError(w, 404, "PLUGIN_NOT_FOUND", "插件不存在")
		return
	}
	rec = normalizePlugin(rec)
	if rec.Status != "enabled" {
		writeAPIError(w, 409, "PLUGIN_DISABLED", "插件未启用")
		return
	}
	data, err := s.readManagedPluginAsset(rec, name)
	if err != nil {
		writeAPIError(w, 404, "PLUGIN_RESOURCE_MISSING", "插件 UI 资源不存在")
		return
	}
	w.Header().Set("Content-Type", guessContentType(name))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
func pluginPermission(rec protocol.PluginRecord, permission string) bool {
	for _, declared := range rec.Permissions {
		if declared == permission {
			return true
		}
		if strings.HasSuffix(declared, "*") && strings.HasPrefix(permission, strings.TrimSuffix(declared, "*")) {
			return true
		}
	}
	return false
}
func (s *mvpStore) beginPluginRPC(key string, maxRate, maxInflight int) bool {
	p := s.pluginRuntime
	p.mu.Lock()
	defer p.mu.Unlock()
	rate := p.rates[key]
	if rate == nil {
		rate = &pluginRate{}
		p.rates[key] = rate
	}
	if time.Since(rate.since) > time.Second {
		rate.since = time.Now()
		rate.count = 0
	}
	if rate.count >= maxRate || rate.inflight >= maxInflight {
		return false
	}
	rate.count++
	rate.inflight++
	return true
}
func (s *mvpStore) endPluginRPC(key string) {
	p := s.pluginRuntime
	p.mu.Lock()
	defer p.mu.Unlock()
	if rate := p.rates[key]; rate != nil {
		rate.inflight--
	}
}
func (s *mvpStore) handlePluginRPC(w http.ResponseWriter, r *http.Request, id string) {
	principal, _ := principalForRequest(s.authFromHub(), r)
	key := principal.UserID + ":" + id
	if !s.beginPluginRPC(key, 30, 8) {
		writeAPIError(w, 429, "PLUGIN_RATE_LIMIT", "插件请求过于频繁")
		return
	}
	defer s.endPluginRPC(key)
	var input struct {
		Method           string          `json:"method"`
		Params           json.RawMessage `json:"params"`
		ExpectedRevision int64           `json:"expectedRevision"`
	}
	raw, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if readErr != nil || json.Unmarshal(raw, &input) != nil {
		writeAPIError(w, 400, "PLUGIN_RPC_INVALID", "RPC 超过大小限制或格式无效")
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.state.Plugins[id]
	if !ok {
		writeAPIError(w, 404, "PLUGIN_NOT_FOUND", "插件不存在")
		return
	}
	if rec.Status != "enabled" {
		writeAPIError(w, 409, "PLUGIN_DISABLED", "插件已停用")
		return
	}
	if rec.Revision != input.ExpectedRevision {
		writeAPIError(w, 409, "PLUGIN_REVISION_CONFLICT", "插件版本已改变")
		return
	}
	var result interface{}
	switch input.Method {
	case "auth.currentUser":
		result = map[string]string{"id": principal.UserID, "displayName": principal.DisplayName}
	case "auth.check":
		var query struct {
			Permission string `json:"permission"`
			ResourceID string `json:"resourceId"`
		}
		json.Unmarshal(input.Params, &query)
		allowed := false
		if query.ResourceID != "" {
			resource, ok := s.state.Resources[query.ResourceID]
			allowed = ok && query.Permission == "resource.read:"+resource.Type && roleAllows(principal.Role, "resource.read") && resourceAllows(principal, resource, "read") && pluginPermission(rec, query.Permission)
		} else if query.Permission == "ui.notify" || query.Permission == "ui.command" || strings.HasPrefix(query.Permission, "event.subscribe:") {
			allowed = pluginPermission(rec, query.Permission)
		}
		result = allowed
	case "resources.get":
		var query struct {
			ID string `json:"id"`
		}
		json.Unmarshal(input.Params, &query)
		resource, exists := s.state.Resources[query.ID]
		if !exists || !roleAllows(principal.Role, "resource.read") || !resourceAllows(principal, resource, "read") || !pluginPermission(rec, "resource.read:"+resource.Type) {
			writeAPIError(w, 403, "PLUGIN_PERMISSION_DENIED", "插件没有读取该资源的权限")
			return
		}
		result = resource
	case "resources.list":
		var query struct {
			Type   string `json:"type"`
			Cursor string `json:"cursor"`
		}
		json.Unmarshal(input.Params, &query)
		resources := []protocol.ResourceRecord{}
		for _, resource := range s.state.Resources {
			if resource.ID > query.Cursor && (query.Type == "" || resource.Type == query.Type) && roleAllows(principal.Role, "resource.read") && resourceAllows(principal, resource, "read") && pluginPermission(rec, "resource.read:"+resource.Type) {
				resources = append(resources, resource)
			}
		}
		sort.Slice(resources, func(i, j int) bool { return resources[i].ID < resources[j].ID })
		cursor := ""
		if len(resources) > 100 {
			resources = resources[:100]
			cursor = resources[99].ID
		}
		result = map[string]interface{}{"items": resources, "nextCursor": cursor}
	case "events.check":
		var query struct {
			Type       string `json:"type"`
			ResourceID string `json:"resourceId"`
			EventID    string `json:"eventId"`
		}
		json.Unmarshal(input.Params, &query)
		allowed := pluginPermission(rec, "event.subscribe:"+query.Type) || pluginPermission(rec, "event.subscribe:workspace."+query.Type)
		allowed = allowed && s.pluginEventAllowedLocked(principal, rec, query.Type, query.EventID)
		if query.ResourceID != "" {
			resource, exists := s.state.Resources[query.ResourceID]
			allowed = allowed && exists && roleAllows(principal.Role, "resource.read") && resourceAllows(principal, resource, "read") && pluginPermission(rec, "resource.read:"+resource.Type)
		}
		result = allowed
	default:
		writeAPIError(w, 400, "PLUGIN_METHOD_UNSUPPORTED", "不支持的 RPC 方法")
		return
	}
	encoded, err := json.Marshal(map[string]interface{}{"result": result})
	if err != nil || len(encoded) > 64*1024 {
		writeAPIError(w, 413, "PLUGIN_RPC_LIMIT", "RPC 结果超过 64 KiB，请缩小查询范围")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(encoded)
}

// Resolve event references from server history rather than trusting a client's
// resource ID. Only the metadata of supported, readable business events passes.
func (s *mvpStore) pluginEventAllowedLocked(principal authPrincipal, rec protocol.PluginRecord, kind, eventID string) bool {
	if !roleAllows(principal.Role, "resource.read") {
		return false
	}
	s.hub.mu.Lock()
	events := s.hub.store.Retained()
	s.hub.mu.Unlock()
	var payload map[string]interface{}
	found := false
	for _, event := range events {
		if event.EventID == eventID && event.Type == kind {
			raw, _ := json.Marshal(event.Payload)
			_ = json.Unmarshal(raw, &payload)
			found = true
			break
		}
	}
	if !found {
		return false
	}
	switch kind {
	case "resources.changed":
		for _, permission := range rec.Permissions {
			if strings.HasPrefix(permission, "resource.read:") {
				return true
			}
		}
	case "code.version.created":
		id, _ := payload["fileId"].(string)
		resource, exists := s.state.Resources[id]
		return exists && resourceAllows(principal, resource, "read") && pluginPermission(rec, "resource.read:"+resource.Type)
	case "chat.message.created", "chat.message.updated", "chat.message.deleted":
		id, _ := payload["messageId"].(string)
		message, exists := s.state.Messages[id]
		if !exists {
			return false
		}
		channel, exists := s.state.Channels[message.ChannelID]
		resource, ok := s.state.Resources[message.ChannelID]
		return exists && ok && channelAllows(principal, channel) && resourceAllows(principal, resource, "read") && (pluginPermission(rec, "resource.read:chat.channel") || pluginPermission(rec, "resource.read:chat.message"))
	case "chat.channels.changed":
		return pluginPermission(rec, "resource.read:chat.channel")
	}
	return false
}
