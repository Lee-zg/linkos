package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

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
