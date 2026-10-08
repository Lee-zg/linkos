package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Runner accepts only isolated container jobs; it never executes commands
// directly on the host when Docker or Podman is unavailable.
func main() {
	log.SetFlags(0)
	service := newRunnerService()
	if len(os.Args) > 1 {
		if os.Args[1] != "doctor" {
			log.Fatal("usage: linkos-runner [doctor]")
		}
		os.Setenv("LINKOS_ENV", "production")
		engine, err := service.engine()
		if err != nil {
			log.Fatal(err)
		}
		writeJSON := json.NewEncoder(os.Stdout)
		_ = writeJSON.Encode(map[string]string{"engine": engine, "status": "ready", "workspace": "same-host rootless"})
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go service.startGatewayHeartbeat(ctx)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		engine, err := service.engine()
		if err != nil {
			write(w, http.StatusServiceUnavailable, map[string]interface{}{"status": "unavailable", "error": "RUNNER_UNAVAILABLE", "runnerId": service.runnerID, "time": time.Now().UTC()})
			return
		}
		write(w, 200, map[string]interface{}{"status": "ok", "runnerId": service.runnerID, "engine": engine, "time": time.Now().UTC()})
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		service.register(w, r)
	})
	mux.HandleFunc("/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
			return
		}
		if !service.authorized(r) {
			writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "runner token is invalid")
			return
		}
		write(w, http.StatusOK, map[string]interface{}{"runnerId": service.runnerID, "status": "online", "lastSeenAt": time.Now().UTC()})
	})
	mux.HandleFunc("/jobs", func(w http.ResponseWriter, r *http.Request) {
		service.createJob(w, r)
	})
	mux.HandleFunc("/jobs/", func(w http.ResponseWriter, r *http.Request) {
		service.handleJob(w, r)
	})
	address := strings.TrimSpace(os.Getenv("LINKOS_LISTEN"))
	if address == "" {
		address = "127.0.0.1:9797"
	}
	server := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		service.mu.Lock()
		for _, job := range service.jobs {
			if job.Cancel != nil {
				job.Cancel()
			}
		}
		service.mu.Unlock()
		_ = server.Shutdown(context.Background())
	}()
	certFile, keyFile := strings.TrimSpace(os.Getenv("LINKOS_TLS_CERT_FILE")), strings.TrimSpace(os.Getenv("LINKOS_TLS_KEY_FILE"))
	if (certFile == "") != (keyFile == "") {
		log.Fatal("LINKOS_TLS_CERT_FILE and LINKOS_TLS_KEY_FILE must be configured together")
	}
	log.Printf(`{"level":"info","service":"runner","message":"listening","address":%q,"tls":%t}`, address, certFile != "")
	if certFile != "" {
		if err := server.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
		return
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
func write(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
