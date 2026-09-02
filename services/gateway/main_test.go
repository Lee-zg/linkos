package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSnapshotShape(t *testing.T) {
	data := snapshot()
	workspace, ok := data["workspace"].(map[string]interface{})
	if !ok || workspace["id"] != "demo" {
		t.Fatalf("unexpected workspace snapshot: %#v", data["workspace"])
	}
}
func TestHealthHandler(t *testing.T) {
	h := httptest.NewRecorder()
	writeJSON(h, 200, map[string]string{"status": "ok"})
	if h.Code != 200 {
		t.Fatalf("expected 200, got %d", h.Code)
	}
}

func TestMemoryEventStoreReplayAndRetention(t *testing.T) {
	store := newMemoryEventStore(2)
	first := store.Append("test.one", map[string]string{"value": "one"})
	second := store.Append("test.two", map[string]string{"value": "two"})
	third := store.Append("test.three", map[string]string{"value": "three"})

	if first.Seq != 1 || second.Seq != 2 || third.Seq != 3 {
		t.Fatalf("unexpected sequence: %d, %d, %d", first.Seq, second.Seq, third.Seq)
	}
	if events, complete := store.Since(1); !complete || len(events) != 2 || events[0].Seq != 2 || events[1].Seq != 3 {
		t.Fatalf("unexpected replay after retained cursor: complete=%v events=%#v", complete, events)
	}
	if events, complete := store.Since(0); complete || len(events) != 0 {
		t.Fatalf("expected snapshot requirement before retention window: complete=%v events=%#v", complete, events)
	}
}

func TestWebSocketReplaysEventsAfterCursor(t *testing.T) {
	h := newHub()
	h.emit("test.one", map[string]string{"value": "one"})
	h.emit("test.two", map[string]string{"value": "two"})
	h.emit("test.three", map[string]string{"value": "three"})

	server := httptest.NewServer(http.HandlerFunc(h.handleWS))
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "?workspace=demo&last_event_seq=1"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	var ready event
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready: %v", err)
	}
	if ready.Type != "workspace.ready" || ready.Seq != 3 {
		t.Fatalf("unexpected ready event: %#v", ready)
	}

	for _, wantSeq := range []int64{2, 3} {
		var replay event
		if err := conn.ReadJSON(&replay); err != nil {
			t.Fatalf("read replay seq %d: %v", wantSeq, err)
		}
		if replay.Seq != wantSeq {
			t.Fatalf("expected replay seq %d, got %#v", wantSeq, replay)
		}
	}
}

func TestWebSocketRequestsSnapshotOutsideRetentionWindow(t *testing.T) {
	h := newHubWithStore(newMemoryEventStore(1))
	h.emit("test.one", map[string]string{"value": "one"})
	h.emit("test.two", map[string]string{"value": "two"})

	server := httptest.NewServer(http.HandlerFunc(h.handleWS))
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "?workspace=demo&last_event_seq=0"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	var ready event
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready: %v", err)
	}
	var snapshotRequired event
	if err := conn.ReadJSON(&snapshotRequired); err != nil {
		t.Fatalf("read snapshot requirement: %v", err)
	}
	if snapshotRequired.Type != "workspace.snapshot.required" {
		t.Fatalf("expected snapshot requirement, got %#v", snapshotRequired)
	}
}

func TestWebSocketReplaysAcrossRestart(t *testing.T) {
	path := testSQLitePath(t)
	beforeRestart, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("open backend: %v", err)
	}
	firstHub := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, beforeRestart))
	firstHub.emit("chat.message.created", map[string]string{"body": "before restart"})
	second := firstHub.emit("chat.message.created", map[string]string{"body": "still here"})
	if err := beforeRestart.Close(); err != nil {
		t.Fatalf("close backend: %v", err)
	}

	afterRestart, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen backend: %v", err)
	}
	defer afterRestart.Close()
	secondHub := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, afterRestart))

	server := httptest.NewServer(http.HandlerFunc(secondHub.handleWS))
	defer server.Close()
	url := "ws" + server.URL[len("http"):] + "?workspace=demo&last_event_seq=0"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	var ready event
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready: %v", err)
	}
	if ready.Type != "workspace.ready" || ready.Seq != second.Seq {
		t.Fatalf("ready must report restored seq %d, got %#v", second.Seq, ready)
	}
	for _, wantBody := range []string{"before restart", "still here"} {
		var replay event
		if err := conn.ReadJSON(&replay); err != nil {
			t.Fatalf("read replayed event %q: %v", wantBody, err)
		}
		payload, ok := replay.Payload.(map[string]interface{})
		if !ok || payload["body"] != wantBody {
			t.Fatalf("replayed event must carry pre-restart payload %q, got %#v", wantBody, replay.Payload)
		}
	}
}

// dialHubWS connects a WebSocket client to the hub and drains the initial
// workspace.ready frame so the caller can observe subsequent broadcasts.
func dialHubWS(t *testing.T, h *hub) (*websocket.Conn, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(h.handleWS))
	url := "ws" + server.URL[len("http"):] + "?workspace=demo&last_event_seq=0"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		server.Close()
		t.Fatalf("dial websocket: %v", err)
	}
	var ready event
	if err := conn.ReadJSON(&ready); err != nil {
		conn.Close()
		server.Close()
		t.Fatalf("read ready: %v", err)
	}
	if ready.Type != "workspace.ready" {
		conn.Close()
		server.Close()
		t.Fatalf("expected workspace.ready, got %#v", ready)
	}
	return conn, server
}

func TestPublishMessageDeduplicatesSameClientMsgID(t *testing.T) {
	h := newHub()
	conn, server := dialHubWS(t, h)
	defer conn.Close()
	defer server.Close()

	baseSeq := h.store.CurrentSeq()
	first, dup1 := h.publishMessage("hello", "general", "client-abc")
	second, dup2 := h.publishMessage("hello", "general", "client-abc")

	if dup1 {
		t.Fatalf("first publish must not be a duplicate: %#v", first)
	}
	if !dup2 {
		t.Fatalf("second publish with same clientMsgId must be a duplicate: %#v", second)
	}
	if first.EventID != second.EventID || first.Seq != second.Seq {
		t.Fatalf("duplicate must return the original event: first=%#v second=%#v", first, second)
	}
	if got := h.store.CurrentSeq(); got != baseSeq+1 {
		t.Fatalf("store must advance by exactly one event, base=%d got=%d", baseSeq, got)
	}

	// Exactly one broadcast: read it, then confirm no second frame arrives.
	var broadcast event
	if err := conn.ReadJSON(&broadcast); err != nil {
		t.Fatalf("read broadcast: %v", err)
	}
	if broadcast.EventID != first.EventID {
		t.Fatalf("broadcast must be the first event: %#v", broadcast)
	}
	_ = conn.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	var extra event
	if err := conn.ReadJSON(&extra); err == nil {
		t.Fatalf("duplicate publish must not broadcast again, got %#v", extra)
	}
}

func TestPublishMessageDistinctClientMsgIDsAppendsBoth(t *testing.T) {
	h := newHub()
	conn, server := dialHubWS(t, h)
	defer conn.Close()
	defer server.Close()

	baseSeq := h.store.CurrentSeq()
	first, dup1 := h.publishMessage("one", "general", "client-1")
	second, dup2 := h.publishMessage("two", "general", "client-2")
	if dup1 || dup2 {
		t.Fatalf("distinct clientMsgIds must not dedup: dup1=%v dup2=%v", dup1, dup2)
	}
	if first.Seq == second.Seq || first.EventID == second.EventID {
		t.Fatalf("distinct clientMsgIds must append separate events: %#v %#v", first, second)
	}
	if got := h.store.CurrentSeq(); got != baseSeq+2 {
		t.Fatalf("store must advance by two events, base=%d got=%d", baseSeq, got)
	}
	for _, want := range []string{"one", "two"} {
		var broadcast event
		if err := conn.ReadJSON(&broadcast); err != nil {
			t.Fatalf("read broadcast %q: %v", want, err)
		}
		payload, _ := broadcast.Payload.(map[string]interface{})
		if payload["body"] != want {
			t.Fatalf("expected broadcast body %q, got %#v", want, broadcast.Payload)
		}
	}
}

func TestPublishMessageEmptyClientMsgIDNeverDedups(t *testing.T) {
	h := newHub()
	baseSeq := h.store.CurrentSeq()
	first, dup1 := h.publishMessage("anon", "general", "")
	second, dup2 := h.publishMessage("anon", "general", "")
	if dup1 || dup2 {
		t.Fatalf("empty clientMsgId must never dedup: dup1=%v dup2=%v", dup1, dup2)
	}
	if first.Seq == second.Seq {
		t.Fatalf("empty clientMsgId must append separate events: %#v %#v", first, second)
	}
	if got := h.store.CurrentSeq(); got != baseSeq+2 {
		t.Fatalf("store must advance by two events, base=%d got=%d", baseSeq, got)
	}
}

func TestPublishMessageDedupSurvivesRestart(t *testing.T) {
	path := testSQLitePath(t)
	beforeRestart, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("open backend: %v", err)
	}
	firstHub := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, beforeRestart))
	first, dup1 := firstHub.publishMessage("persist me", "general", "restart-client-1")
	if dup1 {
		t.Fatalf("first publish must not be a duplicate: %#v", first)
	}
	if err := beforeRestart.Close(); err != nil {
		t.Fatalf("close backend: %v", err)
	}

	afterRestart, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatalf("reopen backend: %v", err)
	}
	defer afterRestart.Close()
	secondHub := newHubWithStore(newMemoryEventStoreWithBackend(eventRetention, afterRestart))

	second, dup2 := secondHub.publishMessage("persist me", "general", "restart-client-1")
	if !dup2 {
		t.Fatalf("same clientMsgId after restart must be a duplicate: %#v", second)
	}
	if second.EventID != first.EventID || second.Seq != first.Seq {
		t.Fatalf("restart dedup must return the original event: first=%#v second=%#v", first, second)
	}
	if got := secondHub.store.CurrentSeq(); got != first.Seq {
		t.Fatalf("restart must not append a new event: seq=%d want=%d", got, first.Seq)
	}
}
