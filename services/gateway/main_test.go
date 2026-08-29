package main

import (
	"net/http/httptest"
	"testing"
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
