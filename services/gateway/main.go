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

type hub struct {
	mu      sync.Mutex
	store   eventStore
	clients map[*websocket.Conn]chan []byte
}

func newHub() *hub {
	return &hub{store: newMemoryEventStore(eventRetention), clients: make(map[*websocket.Conn]chan []byte)}
}

func newHubWithStore(store eventStore) *hub {
	if store == nil {
		store = newMemoryEventStore(eventRetention)
	}
	return &hub{store: store, clients: make(map[*websocket.Conn]chan []byte)}
}

func (h *hub) emit(kind string, payload interface{}) event {
	h.mu.Lock()
	e := h.store.Append(kind, payload)
	b, err := json.Marshal(e)
	if err != nil {
		h.mu.Unlock()
		return e
	}
	for _, queue := range h.clients {
		select {
		case queue <- b:
		default:
			log.Printf("dropping event for slow client: %s", kind)
		}
	}
	h.mu.Unlock()
	return e
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
	h.mu.Lock()
	h.clients[conn] = queue
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
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func systemEventID(kind string, seq int64) string {
	return "evt_" + kind + "_" + strconv.FormatInt(seq, 10) + "_" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
}

func main() {
	if len(os.Args) > 1 {
		runMaintenanceCommand(os.Args[1:])
		return
	}
	backend := openBackend()
	defer backend.Close()
	h := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, backend))
	uploads := newUploadStoreWithBackend(defaultUploadRoot(), backend)
	auth := newAuthStore("demo", adminPasscode(), newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
	audit := newAuditStoreWithBackend(backend)
	sessionLimiter := newRateLimiter(12, 0.5)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"status": "ok", "service": "gateway", "time": time.Now().UTC()})
	})
	mux.HandleFunc("/api/v1/discovery", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"workspaces": []interface{}{map[string]interface{}{"id": "demo", "name": "Nimbus Lab", "address": "http://127.0.0.1:8787", "onlineMembers": 12, "tls": false}}})
	})
	registerAccessRoutes(mux, auth, h, audit, sessionLimiter)
	mux.HandleFunc("/api/v1/workspaces/demo/snapshot", requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, snapshot()) }))
	mux.HandleFunc("/api/v1/resources", requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"items": []interface{}{map[string]string{"id": "file_release", "type": "file", "name": "release-candidate.tar.gz"}, map[string]string{"id": "project_gateway", "type": "code.project", "name": "api-gateway"}}, "nextCursor": ""})
	}))
	mux.HandleFunc("/api/v1/uploads", requireActive(auth, "demo", uploads.handleCollection))
	mux.HandleFunc("/api/v1/uploads/", requireActive(auth, "demo", uploads.handleItem))
	mux.HandleFunc("/api/v1/files/", requireActive(auth, "demo", uploads.content.handleDownload))
	mux.HandleFunc("/api/v1/messages", requireActive(auth, "demo", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeJSON(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		var body struct {
			Body        string `json:"body"`
			ChannelID   string `json:"channelId"`
			ClientMsgID string `json:"clientMsgId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Body) == "" {
			writeJSON(w, 400, map[string]string{"error": "invalid_message"})
			return
		}
		h.emit("chat.message.created", map[string]string{"body": body.Body, "author": "你", "channelId": body.ChannelID, "clientMsgId": body.ClientMsgID})
		writeJSON(w, 201, map[string]string{"messageId": "msg_local", "status": "accepted"})
	}))
	mux.HandleFunc("/api/v1/jobs", requireActive(auth, "demo", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeJSON(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		var spec map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&spec)
		id := "job_" + time.Now().UTC().Format("150405.000")
		writeJSON(w, 202, map[string]interface{}{"id": id, "status": "queued", "runnerId": "runner-02"})
		go simulateJob(h, id, spec)
	}))
	mux.HandleFunc("/api/v1/plugins", requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"items": []interface{}{plugin("files.core", "文件", "0.1.0"), plugin("chat.core", "聊天", "0.1.0"), plugin("code.workbench", "代码工作台", "0.1.0"), plugin("runner.exec", "运行任务", "0.1.0")}})
	}))
	mux.HandleFunc("/api/v1/ws", requireActive(auth, "demo", h.handleWS))
	server := &http.Server{Addr: ":8787", Handler: cors(mux), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("LinkOS Gateway listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
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
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
