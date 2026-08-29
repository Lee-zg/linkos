package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// Runner is intentionally a safe protocol stub. Execution remains disabled until a sandbox adapter passes review.
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		write(w, 200, map[string]interface{}{"status": "ok", "runnerId": "runner-dev", "time": time.Now().UTC()})
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, _ *http.Request) {
		write(w, 201, map[string]interface{}{"runnerId": "runner-dev", "status": "registered", "capabilities": []string{"go/1.23", "node/22"}})
	})
	mux.HandleFunc("/jobs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			write(w, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		write(w, 501, map[string]string{"error": "sandbox_not_configured", "message": "Execution is disabled until a sandbox adapter is configured."})
	})
	log.Printf("LinkOS Runner protocol stub listening on :9797")
	log.Fatal(http.ListenAndServe(":9797", mux))
}
func write(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
