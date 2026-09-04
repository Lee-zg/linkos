package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func (r *runnerService) startGatewayHeartbeat(ctx context.Context) {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("LINKOS_GATEWAY_URL")), "/")
	if baseURL == "" {
		return
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" {
		log.Printf("runner gateway URL is invalid")
		return
	}
	ip := net.ParseIP(parsed.Hostname())
	loopback := strings.EqualFold(parsed.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
	if parsed.Scheme != "https" && !loopback {
		log.Printf("runner gateway URL must use HTTPS outside localhost")
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	if caFile := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_CA_FILE")); caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			log.Printf("runner gateway CA: %v", err)
			return
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			log.Printf("runner gateway CA: no certificates found")
			return
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		client.Transport = transport
	}
	send := func(path string, payload interface{}) {
		raw, _ := json.Marshal(payload)
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(raw))
		request.Header.Set("content-type", "application/json")
		if token := strings.TrimSpace(os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")); token != "" {
			request.Header.Set("X-Runner-Token", token)
		}
		response, err := client.Do(request)
		if err != nil {
			log.Printf("runner gateway heartbeat: %v", err)
			return
		}
		_ = response.Body.Close()
		if response.StatusCode >= 300 {
			log.Printf("runner gateway heartbeat: status %d", response.StatusCode)
		}
	}
	send("/api/v1/runners/register", map[string]interface{}{"id": r.runnerID, "workspaceId": "demo", "platform": "container", "version": "0.1.0", "capabilities": []string{"docker", "podman", "network-deny", "resource-limits"}, "labels": map[string]string{"pool": "default"}, "status": "online"})
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			send("/api/v1/runners/heartbeat", map[string]string{"id": r.runnerID, "status": "online"})
		}
	}
}
