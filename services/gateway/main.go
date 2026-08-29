package main

import (
	"encoding/json"
	"log"
	"net/http"
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
type hub struct {
	mu      sync.Mutex
	seq     int64
	clients map[*websocket.Conn]chan []byte
}

func newHub() *hub { return &hub{clients: make(map[*websocket.Conn]chan []byte)} }
func (h *hub) emit(kind string, payload interface{}) {
	h.mu.Lock()
	h.seq++
	e := event{1, kind, "evt_" + time.Now().UTC().Format("20060102150405.000000000"), h.seq, time.Now().UTC().Format(time.RFC3339Nano), "demo", "gateway", payload}
	b, err := json.Marshal(e)
	if err != nil {
		h.mu.Unlock()
		return
	}
	for _, queue := range h.clients {
		select {
		case queue <- b:
		default:
			log.Printf("dropping event for slow client: %s", kind)
		}
	}
	h.mu.Unlock()
}
func (h *hub) handleWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	queue := make(chan []byte, 32)
	h.mu.Lock()
	h.clients[conn] = queue
	currentSeq := h.seq
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.clients, conn); h.mu.Unlock(); close(queue); _ = conn.Close() }()
	_ = conn.WriteJSON(event{1, "workspace.ready", "evt_boot", currentSeq, time.Now().UTC().Format(time.RFC3339Nano), "demo", "gateway", map[string]string{"message": "connected"}})
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

func main() {
	h := newHub()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"status": "ok", "service": "gateway", "time": time.Now().UTC()})
	})
	mux.HandleFunc("/api/v1/discovery", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"workspaces": []interface{}{map[string]interface{}{"id": "demo", "name": "Nimbus Lab", "address": "http://127.0.0.1:8787", "onlineMembers": 12, "tls": false}}})
	})
	mux.HandleFunc("/api/v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeJSON(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		writeJSON(w, 201, map[string]interface{}{"accessToken": "dev-token", "expiresIn": 3600, "workspaceId": "demo"})
	})
	mux.HandleFunc("/api/v1/workspaces/demo/snapshot", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, snapshot()) })
	mux.HandleFunc("/api/v1/resources", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"items": []interface{}{map[string]string{"id": "file_release", "type": "file", "name": "release-candidate.tar.gz"}, map[string]string{"id": "project_gateway", "type": "code.project", "name": "api-gateway"}}, "nextCursor": ""})
	})
	mux.HandleFunc("/api/v1/messages", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/api/v1/jobs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeJSON(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		var spec map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&spec)
		id := "job_" + time.Now().UTC().Format("150405.000")
		writeJSON(w, 202, map[string]interface{}{"id": id, "status": "queued", "runnerId": "runner-02"})
		go simulateJob(h, id, spec)
	})
	mux.HandleFunc("/api/v1/plugins", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"items": []interface{}{plugin("files.core", "文件", "0.1.0"), plugin("chat.core", "聊天", "0.1.0"), plugin("code.workbench", "代码工作台", "0.1.0"), plugin("runner.exec", "运行任务", "0.1.0")}})
	})
	mux.HandleFunc("/api/v1/ws", h.handleWS)
	server := &http.Server{Addr: ":8787", Handler: cors(mux), ReadHeaderTimeout: 5 * time.Second}
	log.Printf("LinkOS Gateway listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
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
