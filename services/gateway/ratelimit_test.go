package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterAllowsBurstThenDeniesAndRefills(t *testing.T) {
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	limiter := newRateLimiterWithClock(3, 1, func() time.Time { return now })

	for i := 0; i < 3; i++ {
		if !limiter.allow("192.0.2.1") {
			t.Fatalf("expected burst request %d to be allowed", i+1)
		}
	}
	if limiter.allow("192.0.2.1") {
		t.Fatal("expected fourth immediate request to be denied")
	}
	if !limiter.allow("192.0.2.2") {
		t.Fatal("expected separate key to have its own budget")
	}

	now = now.Add(2 * time.Second)
	if !limiter.allow("192.0.2.1") {
		t.Fatal("expected refill after elapsed time to allow again")
	}
	if !limiter.allow("192.0.2.1") {
		t.Fatal("expected refill over 2s to grant full capacity")
	}
	if limiter.allow("192.0.2.1") {
		t.Fatal("expected capacity to stay bounded after refill")
	}
}

func TestRateLimiterPrunesStaleBuckets(t *testing.T) {
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	limiter := newRateLimiterWithClock(2, 1, func() time.Time { return now })

	for i := 0; i < rateLimiterMaxKeys+10; i++ {
		key := "10.0." + string(rune('a'+i%26)) + "." + string(rune('a'+(i/26)%26))
		limiter.allow(key)
	}
	if got := limiter.size(); got > rateLimiterMaxKeys {
		t.Fatalf("expected bucket map bounded to %d keys, got %d", rateLimiterMaxKeys, got)
	}
}

func TestSessionIssueRateLimitedReturns429(t *testing.T) {
	auth, hub := newTestGateway()
	audit := newAuditStore()
	limiter := newRateLimiter(2, 0)
	handler := handleSessionIssue(auth, hub, audit, limiter)

	post := func(remoteAddr string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]interface{}{"workspaceId": "demo", "displayName": "限流测试", "accessType": "login"})
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = remoteAddr
		recorder := httptest.NewRecorder()
		handler(recorder, request)
		return recorder
	}

	if recorder := post("192.0.2.7:1000"); recorder.Code != http.StatusCreated {
		t.Fatalf("expected first request created, got %d", recorder.Code)
	}
	if recorder := post("192.0.2.7:1001"); recorder.Code != http.StatusCreated {
		t.Fatalf("expected second request created, got %d", recorder.Code)
	}
	blocked := post("192.0.2.7:1002")
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 when rate limited, got %d body=%s", blocked.Code, blocked.Body.String())
	}
	if body := recordedBody(t, blocked); body["error"] != "RATE_LIMITED" {
		t.Fatalf("expected RATE_LIMITED error code, got %#v", body)
	}
	if recorder := post("192.0.2.8:1000"); recorder.Code != http.StatusCreated {
		t.Fatalf("expected different client unaffected, got %d", recorder.Code)
	}
}
