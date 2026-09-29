package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type event struct {
	V           int         `json:"v"`
	Type        string      `json:"type"`
	EventID     string      `json:"eventId"`
	Seq         int64       `json:"seq"`
	TS          string      `json:"ts"`
	WorkspaceID string      `json:"workspaceId"`
	ActorID     string      `json:"actorId,omitempty"`
	Payload     interface{} `json:"payload"`
}

// eventStore is intentionally small so the in-memory PoC can be replaced by
// SQLite without changing WebSocket or HTTP handlers.
type eventStore interface {
	Append(kind string, payload interface{}) event
	Since(afterSeq int64) (events []event, complete bool)
	CurrentSeq() int64
	Retained() []event
}

const eventRetention = 1000

// memoryEventStore is a bounded append-only history. The hub mutex is the
// synchronization boundary for this implementation; with a durable
// persistBackend the retention window and seq survive restarts so reconnect
// replay keeps working across gateway restarts.
type memoryEventStore struct {
	capacity int
	backend  persistBackend
	events   []event
	seq      int64
}

func newMemoryEventStore(capacity int) *memoryEventStore {
	return newMemoryEventStoreWithBackend(capacity, memoryBackend{})
}

func newMemoryEventStoreWithBackend(capacity int, backend persistBackend) *memoryEventStore {
	if capacity < 1 {
		capacity = 1
	}
	s := &memoryEventStore{capacity: capacity, backend: backend}
	stored, err := backend.loadEvents()
	if err != nil {
		log.Printf("load events: %v", err)
		return s
	}
	if len(stored) > capacity {
		stored = stored[len(stored)-capacity:]
	}
	s.events = stored
	if len(stored) > 0 {
		s.seq = stored[len(stored)-1].Seq
	}
	return s
}

func (s *memoryEventStore) Append(kind string, payload interface{}) event {
	s.seq++
	e := event{
		V:           1,
		Type:        kind,
		EventID:     "evt_" + strconv.FormatInt(s.seq, 10) + "_" + time.Now().UTC().Format("20060102150405.000000000"),
		Seq:         s.seq,
		TS:          time.Now().UTC().Format(time.RFC3339Nano),
		WorkspaceID: "demo",
		ActorID:     "gateway",
		Payload:     payload,
	}
	s.events = append(s.events, e)
	if len(s.events) > s.capacity {
		s.events = s.events[len(s.events)-s.capacity:]
	}
	if err := s.backend.appendEvent(e); err != nil {
		log.Printf("persist event seq %d: %v", e.Seq, err)
	}
	return e
}

func (s *memoryEventStore) Since(afterSeq int64) ([]event, bool) {
	if afterSeq < 0 {
		afterSeq = 0
	}
	if afterSeq >= s.seq {
		return nil, true
	}
	if len(s.events) == 0 {
		return nil, false
	}
	oldest := s.events[0].Seq
	if afterSeq < oldest-1 {
		return nil, false
	}
	result := make([]event, 0, len(s.events))
	for _, e := range s.events {
		if e.Seq > afterSeq {
			result = append(result, e)
		}
	}
	return result, true
}

func (s *memoryEventStore) CurrentSeq() int64 { return s.seq }

// Retained returns a copy of the events currently inside the retention window,
// oldest first. The hub uses it to rebuild derived indexes (such as the
// clientMsgId dedup map) after a restart from the persisted window.
func (s *memoryEventStore) Retained() []event {
	out := make([]event, len(s.events))
	copy(out, s.events)
	return out
}

// messageDedupRetention bounds the clientMsgId idempotency index so a
// long-lived gateway does not grow it without limit. It matches the event
// retention window: once a message has scrolled out of replay history, its
// clientMsgId no longer needs dedup protection.
const messageDedupRetention = 1000

type hub struct {
	mu        sync.Mutex
	store     eventStore
	clients   map[*websocket.Conn]*wsClient
	seen      map[string]event
	seenOrder []string
}

type wsClient struct {
	queue   chan []byte
	filters map[string]struct{}
}

var unknownWSEvents atomic.Int64
var slowWSClients atomic.Int64
var messageSearchRequests atomic.Int64
var messageSearchNanos atomic.Int64

func (c *wsClient) allows(kind string) bool {
	if len(c.filters) == 0 {
		return true
	}
	_, ok := c.filters[kind]
	return ok
}

func newHub() *hub {
	return &hub{
		store:   newMemoryEventStore(eventRetention),
		clients: make(map[*websocket.Conn]*wsClient),
		seen:    make(map[string]event),
	}
}

func newHubWithStore(store eventStore) *hub {
	if store == nil {
		store = newMemoryEventStore(eventRetention)
	}
	h := &hub{
		store:   store,
		clients: make(map[*websocket.Conn]*wsClient),
		seen:    make(map[string]event),
	}
	h.seedDedupFromRetained()
	return h
}

// seedDedupFromRetained rebuilds the clientMsgId idempotency index from the
// events already inside the store's retention window (for example reloaded from
// SQLite after a restart), so write idempotency survives a gateway restart for
// every message that is still replayable. It runs at construction, before the
// hub is shared with any goroutine, so it takes no lock.
func (h *hub) seedDedupFromRetained() {
	for _, e := range h.store.Retained() {
		if e.Type != "chat.message.created" {
			continue
		}
		if id := clientMsgIDFromPayload(e.Payload); id != "" {
			h.recordSeenLocked(id, e)
		}
	}
}

// clientMsgIDFromPayload extracts the clientMsgId from a chat event payload,
// handling both the in-process map[string]string form and the
// map[string]interface{} form produced by JSON-decoding a persisted event.
func clientMsgIDFromPayload(payload interface{}) string {
	switch p := payload.(type) {
	case map[string]string:
		return p["clientMsgId"]
	case map[string]interface{}:
		if id, ok := p["clientMsgId"].(string); ok {
			return id
		}
	}
	return ""
}

func (h *hub) emit(kind string, payload interface{}) event {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.emitLocked(kind, payload)
}

// emitLocked appends an event and broadcasts it to every connected client. It
// assumes h.mu is already held.
func (h *hub) emitLocked(kind string, payload interface{}) event {
	e := h.store.Append(kind, payload)
	b, err := json.Marshal(e)
	if err != nil {
		return e
	}
	for _, client := range h.clients {
		if !client.allows(kind) {
			continue
		}
		select {
		case client.queue <- b:
		default:
			slowWSClients.Add(1)
			select {
			case <-client.queue:
			default:
			}
			snapshot := event{1, "workspace.snapshot.required", systemEventID("slow", e.Seq), e.Seq, time.Now().UTC().Format(time.RFC3339Nano), "demo", "gateway", map[string]interface{}{"reason": "slow_client", "currentEventSeq": e.Seq}}
			if frame, marshalErr := json.Marshal(snapshot); marshalErr == nil {
				select {
				case client.queue <- frame:
				default:
				}
			}
		}
	}
	return e
}

// publishMessage emits a chat.message.created event with idempotency keyed on
// the client-supplied clientMsgId. A retry carrying an already-seen non-empty
// clientMsgId returns the original event and duplicate=true without appending a
// second event or re-broadcasting, satisfying the "重复 eventId 幂等" contract.
// An empty clientMsgId is never deduplicated. It assumes nothing about locking:
// the hub mutex is taken here.
func (h *hub) publishMessage(body, channelID, clientMsgID string) (event, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if clientMsgID != "" {
		if prev, ok := h.seen[clientMsgID]; ok {
			return prev, true
		}
	}
	e := h.emitLocked("chat.message.created", map[string]string{
		"body":        body,
		"author":      "你",
		"channelId":   channelID,
		"clientMsgId": clientMsgID,
	})
	if clientMsgID != "" {
		h.recordSeenLocked(clientMsgID, e)
	}
	return e, false
}

// recordSeenLocked adds clientMsgID to the bounded FIFO dedup index, evicting
// the oldest entries past messageDedupRetention. It assumes h.mu is held.
func (h *hub) recordSeenLocked(clientMsgID string, e event) {
	if _, exists := h.seen[clientMsgID]; !exists {
		h.seenOrder = append(h.seenOrder, clientMsgID)
	}
	h.seen[clientMsgID] = e
	for len(h.seenOrder) > messageDedupRetention {
		oldest := h.seenOrder[0]
		h.seenOrder = h.seenOrder[1:]
		delete(h.seen, oldest)
	}
}
func (h *hub) handleWS(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID != "" && workspaceID != "demo" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace_not_found"})
		return
	}
	lastSeq := int64(0)
	if raw := r.URL.Query().Get("last_event_seq"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_last_event_seq"})
			return
		}
		lastSeq = parsed
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	queue := make(chan []byte, 32)
	filters := make(map[string]struct{})
	for _, kind := range strings.Split(r.URL.Query().Get("events"), ",") {
		if kind = strings.TrimSpace(kind); kind != "" {
			filters[kind] = struct{}{}
		}
	}
	client := &wsClient{queue: queue, filters: filters}
	h.mu.Lock()
	h.clients[conn] = client
	currentSeq := h.store.CurrentSeq()
	history, replayable := h.store.Since(lastSeq)
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.clients, conn); h.mu.Unlock(); close(queue); _ = conn.Close() }()
	ready := event{1, "workspace.ready", systemEventID("ready", currentSeq), currentSeq, time.Now().UTC().Format(time.RFC3339Nano), "demo", "gateway", map[string]interface{}{"message": "connected", "replayable": replayable}}
	if err := conn.WriteJSON(ready); err != nil {
		return
	}
	if !replayable {
		snapshotRequired := event{1, "workspace.snapshot.required", systemEventID("snapshot", currentSeq), currentSeq, time.Now().UTC().Format(time.RFC3339Nano), "demo", "gateway", map[string]interface{}{"lastEventSeq": lastSeq, "currentEventSeq": currentSeq}}
		if err := conn.WriteJSON(snapshotRequired); err != nil {
			return
		}
	} else {
		for _, historicalEvent := range history {
			if !client.allows(historicalEvent.Type) {
				continue
			}
			if err := conn.WriteJSON(historicalEvent); err != nil {
				return
			}
		}
	}
	go func() {
		for message := range queue {
			if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		}
	}()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if string(raw) == "ping" {
			continue
		}
		var command struct {
			Type   string   `json:"type"`
			Events []string `json:"events"`
		}
		if json.Unmarshal(raw, &command) == nil && command.Type == "subscribe" {
			next := make(map[string]struct{}, len(command.Events))
			for _, kind := range command.Events {
				if kind = strings.TrimSpace(kind); kind != "" {
					next[kind] = struct{}{}
				}
			}
			h.mu.Lock()
			client.filters = next
			h.mu.Unlock()
			continue
		}
		unknownWSEvents.Add(1)
	}
}

func systemEventID(kind string, seq int64) string {
	return "evt_" + kind + "_" + strconv.FormatInt(seq, 10) + "_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
}

func main() {
	log.SetFlags(0)
	if len(os.Args) > 1 {
		runMaintenanceCommand(os.Args[1:])
		return
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("LINKOS_ENV")), "production") && len(pluginTrustedKeys()) == 0 {
		log.Fatal("LINKOS_PLUGIN_TRUSTED_KEYS is required when LINKOS_ENV=production")
	}
	backend := openBackend()
	defer backend.Close()
	h := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, backend))
	uploads := newUploadStoreWithBackend(defaultUploadRoot(), backend)
	auth := newAuthStore("demo", adminPasscode(), newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
	audit := newAuditStoreWithBackend(backend)
	sessionCapacity := 12
	sessionRefill := 0.5
	if raw := os.Getenv("LINKOS_SESSION_RATE_CAPACITY"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			sessionCapacity = v
		}
	}
	if raw := os.Getenv("LINKOS_SESSION_RATE_REFILL"); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil && v > 0 {
			sessionRefill = v
		}
	}
	sessionLimiter := newRateLimiter(sessionCapacity, sessionRefill)
	mvp := newMVPStore(backend, h)
	mvp.audit = audit
	mvp.contentDownload = uploads.content.handleDownload
	mvp.content = uploads.content
	if uploads.loadErr != nil {
		log.Fatalf("initialize uploads: %v", uploads.loadErr)
	}
	if err := mvp.initializeFileStorage(uploads.content); err != nil {
		log.Fatalf("initialize file storage: %v", err)
	}
	registerMVPAuth(mvp, auth)
	uploads.auth = auth
	uploads.committer = mvp
	discovery := newDiscoveryService()
	defer discovery.close()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"status": "ok", "service": "gateway", "time": time.Now().UTC()})
	})
	mux.HandleFunc("/api/v1/discovery", func(w http.ResponseWriter, _ *http.Request) {
		workspaces := []interface{}{map[string]interface{}{"id": "demo", "name": "Nimbus Lab", "address": "http://127.0.0.1:8787", "version": "0.1.0", "onlineMembers": 12, "tls": false, "source": "gateway"}}
		for _, peer := range discovery.list() {
			workspaces = append(workspaces, peer)
		}
		writeJSON(w, 200, map[string]interface{}{"workspaces": workspaces})
	})
	registerAccessRoutes(mux, auth, h, audit, sessionLimiter)
	mux.HandleFunc("/api/v1/workspaces/demo/snapshot", requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, snapshot()) }))
	mux.HandleFunc("/api/v1/uploads", requireActive(auth, "demo", uploads.handleCollection))
	mux.HandleFunc("/api/v1/uploads/", requireActive(auth, "demo", uploads.handleItem))
	mux.HandleFunc("/api/v1/files/", requireActive(auth, "demo", mvp.handleAuthorizedDownload))
	registerMVPRoutes(mux, auth, mvp)
	handleJobRoutes(mux, auth, mvp)
	mux.HandleFunc("/api/v1/ws", requireActive(auth, "demo", h.handleWS))
	address := strings.TrimSpace(os.Getenv("LINKOS_LISTEN"))
	if address == "" {
		address = ":8787"
	}
	server := &http.Server{Addr: address, Handler: cors(mux), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 2 * time.Minute}
	certFile, keyFile := strings.TrimSpace(os.Getenv("LINKOS_TLS_CERT_FILE")), strings.TrimSpace(os.Getenv("LINKOS_TLS_KEY_FILE"))
	if (certFile == "") != (keyFile == "") {
		log.Fatal("LINKOS_TLS_CERT_FILE and LINKOS_TLS_KEY_FILE must be configured together")
	}
	log.Printf(`{"level":"info","service":"gateway","message":"listening","address":%q,"tls":%t}`, server.Addr, certFile != "")
	var serveErr error
	if certFile != "" {
		serveErr = server.ListenAndServeTLS(certFile, keyFile)
	} else {
		serveErr = server.ListenAndServe()
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		log.Fatal(serveErr)
	}
}

// runMaintenanceCommand implements the offline backup/restore operations.
// Both require LINKOS_DATA_DIR and run while the gateway is stopped, so the
// snapshot or restored image is authoritative when the server starts again.
func runMaintenanceCommand(args []string) {
	dir := strings.TrimSpace(os.Getenv("LINKOS_DATA_DIR"))
	if dir == "" {
		log.Fatal("LINKOS_DATA_DIR must be set for backup/restore")
	}
	switch args[0] {
	case "backup":
		backend := openBackend()
		defer backend.Close()
		manifest, err := backend.backupTo(filepath.Join(dir, "backups"))
		if err != nil {
			log.Fatalf("backup: %v", err)
		}
		raw, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			log.Fatalf("backup: %v", err)
		}
		fmt.Println(string(raw))
	case "restore":
		if len(args) != 2 {
			log.Fatal("usage: gateway restore <backup-file>")
		}
		if err := restoreBackup(dir, args[1]); err != nil {
			log.Fatalf("restore: %v", err)
		}
		log.Printf("restored %s to %s", args[1], filepath.Join(dir, "gateway.db"))
	default:
		log.Fatalf("unknown command %q (expected backup or restore <file>)", args[0])
	}
}

func simulateJob(h *hub, id string, spec map[string]interface{}) {
	command, _ := spec["command"].(string)
	if command == "" {
		command = "demo task"
	}
	time.Sleep(550 * time.Millisecond)
	h.emit("job.status.changed", map[string]interface{}{"jobId": id, "status": "preparing"})
	time.Sleep(650 * time.Millisecond)
	h.emit("job.status.changed", map[string]interface{}{"jobId": id, "status": "running"})
	h.emit("job.log.chunk", map[string]interface{}{"jobId": id, "level": "info", "chunk": "$ " + command + "\nPASS   ./...   0.42s\n"})
	time.Sleep(800 * time.Millisecond)
	h.emit("job.status.changed", map[string]interface{}{"jobId": id, "status": "succeeded"})
}
func snapshot() map[string]interface{} {
	return map[string]interface{}{"workspace": map[string]interface{}{"id": "demo", "name": "Nimbus Lab", "status": "online", "onlineMembers": 12, "totalMembers": 18}, "resources": []interface{}{map[string]interface{}{"id": "project_gateway", "type": "code.project", "name": "api-gateway", "meta": map[string]interface{}{"files": 28}}, map[string]interface{}{"id": "channel_engineering", "type": "chat.channel", "name": "工程协作"}}, "activity": []interface{}{map[string]string{"id": "a1", "actor": "林墨", "action": "更新了", "target": "api-gateway / websocket.go", "time": "刚刚", "tone": "blue"}}}
}
func plugin(id, name, version string) map[string]string {
	return map[string]string{"id": id, "name": name, "version": version, "status": "enabled"}
}
func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID := fmt.Sprintf("tr_%x", time.Now().UTC().UnixNano())
		w.Header().Set("X-Trace-ID", traceID)
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		allowedOrigins := strings.TrimSpace(os.Getenv("LINKOS_ALLOWED_ORIGINS"))
		allowed := origin == "" || allowedOrigins == ""
		if !allowed {
			for _, candidate := range strings.Split(allowedOrigins, ",") {
				if strings.TrimSpace(candidate) == origin {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "origin is not allowed")
			return
		}
		if origin != "" {
			if allowedOrigins == "" {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Runner-Token, X-Request-ID")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
