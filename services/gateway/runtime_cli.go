package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type runtimeState struct {
	PID          int    `json:"pid"`
	InstanceID   string `json:"instanceId"`
	ProjectID    string `json:"projectId,omitempty"`
	URL          string `json:"url"`
	ControlURL   string `json:"controlURL"`
	ControlToken string `json:"controlToken"`
	Version      string `json:"version"`
}

var currentRuntime runtimeState

func acquireDataLock(dir string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return nil, err
	}
	// Keep the lock outside the data tree, which restore replaces atomically.
	file, err := os.OpenFile(filepath.Clean(dir)+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockFile(file); err != nil {
		file.Close()
		return nil, fmt.Errorf("workspace is in use; stop its Gateway before maintenance: %w", err)
	}
	return file, nil
}

func parseRuntimeArgs(args []string) (map[string]string, []string, error) {
	flags := map[string]string{}
	positional := []string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			positional = append(positional, arg)
			continue
		}
		key, value, has := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		switch key {
		case "lan", "dev", "replace", "help", "json", "follow":
			if !has {
				value = "true"
			}
		default:
			if !has {
				i++
				if i >= len(args) || strings.HasPrefix(args[i], "--") {
					return nil, nil, fmt.Errorf("--%s requires a value", key)
				}
				value = args[i]
			}
		}
		switch key {
		case "home", "config", "listen", "public-url", "data-dir", "upload-dir", "plugin-dir", "web-dir", "tls-mode", "tls-cert-file", "tls-key-file", "allowed-origins", "runner-url", "runner-api-token", "admin-passcode", "project-id", "discovery-port", "host", "output", "lan", "dev", "replace", "help", "dev-upstream", "json", "follow", "project", "project-config":
		default:
			return nil, nil, fmt.Errorf("unknown option --%s", key)
		}
		flags[key] = value
	}
	return flags, positional, nil
}

func runtimeCLI(args []string) error {
	if handled, err := dispatchProjectCLI(args); handled {
		return err
	}
	flags, positional, err := parseRuntimeArgs(args)
	if err != nil {
		return err
	}
	command := "serve"
	if len(positional) > 0 {
		command = positional[0]
		positional = positional[1:]
	}
	if flags["help"] != "" || command == "help" {
		fmt.Println("linkos init|serve|doctor|status|logs|backup|restore|tls renew|service install/uninstall|version [--home DIR] [--config FILE]\ninit --lan --host IP_OR_DNS; backup --output FILE; restore ARCHIVE --replace")
		return nil
	}
	if command == "version" {
		return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"version": buildVersion, "commit": buildCommit, "databaseSchema": len(sqliteMigrations)})
	}
	home := flags["home"]
	if home == "" {
		home = defaultHome()
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return err
	}
	file := flags["config"]
	if file == "" {
		file = filepath.Join(home, "linkos.json")
	}
	file, err = filepath.Abs(file)
	if err != nil {
		return err
	}
	activeHome = home
	// Development Web has a separate CA and leaf certificate. Generating it does
	// not lock or change a running Gateway's config, data, or production TLS.
	if command == "tls" && len(positional) == 1 && positional[0] == "dev" {
		hosts := strings.Split(flags["host"], ",")
		for _, host := range hosts {
			ip := net.ParseIP(host)
			if ip != nil {
				if ip.IsUnspecified() || ip.IsMulticast() {
					return errors.New("tls dev --host requires assigned local IP addresses")
				}
				continue
			}
			if err := validateDevCertificateDNS(host); err != nil {
				return err
			}
		}
		return createLANCertificates(filepath.Join(home, "dev-web"), hosts[0], hosts[1:]...)
	}
	overrides := map[string]string{}
	for key, value := range flags {
		envKey := "LINKOS_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
		if key == "project-id" {
			envKey = "LINKOS_PROJECT_ID"
		}
		overrides[envKey] = value
	}
	if command == "init" {
		return initializeRuntime(home, file, flags, overrides)
	}
	c, err := readRuntimeConfig(home, file, overrides)
	if err != nil {
		return err
	}
	c.apply()
	switch command {
	case "healthcheck":
		return runtimeHealthcheck(c)
	case "serve":
		return serveRuntime(home, c)
	case "status":
		state, e := readRuntimeState(home)
		if e != nil {
			return fmt.Errorf("not running: %w", e)
		}
		if e = controlRequest(state, "status"); e != nil {
			return fmt.Errorf("stale instance record: %w", e)
		}
		state.ControlToken = ""
		return json.NewEncoder(os.Stdout).Encode(state)
	case "stop":
		state, e := readRuntimeState(home)
		if e != nil {
			return e
		}
		if e = controlRequest(state, "stop"); e != nil {
			return e
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			lock, e := acquireDataLock(c.DataDir)
			if e == nil {
				lock.Close()
				return nil
			}
			time.Sleep(100 * time.Millisecond)
		}
		return errors.New("Gateway is still draining writes; wait before maintenance")
	case "logs":
		if flags["follow"] == "true" {
			ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer cancel()
			return followRuntimeLog(ctx, filepath.Join(home, "logs", "gateway.log"), os.Stdout)
		}
		f, e := os.Open(filepath.Join(home, "logs", "gateway.log"))
		if e != nil {
			return e
		}
		defer f.Close()
		info, _ := f.Stat()
		if info.Size() > 64*1024 {
			f.Seek(-64*1024, io.SeekEnd)
		}
		_, e = io.Copy(os.Stdout, f)
		return e
	case "backup", "restore":
		lock, e := acquireDataLock(c.DataDir)
		if e != nil {
			return e
		}
		defer lock.Close()
		if command == "backup" {
			output := flags["output"]
			if output == "" {
				output = filepath.Join(home, "backups", "workspace-"+time.Now().UTC().Format("20060102T150405.000000000")+".tar.gz")
			}
			return backupWorkspace(home, file, c, output)
		}
		if len(positional) != 1 {
			return errors.New("usage: linkos restore ARCHIVE [--replace] --home DIR")
		}
		return restoreWorkspace(home, file, c, positional[0], flags["replace"] == "true")
	case "tls":
		if len(positional) != 1 || positional[0] != "renew" {
			return errors.New("usage: linkos tls renew --home DIR")
		}
		u, _ := url.Parse(c.PublicURL)
		if c.TLSMode != "direct" {
			return errors.New("certificate renewal requires direct TLS")
		}
		lock, e := acquireDataLock(c.DataDir)
		if e != nil {
			return e
		}
		defer lock.Close()
		return createLANCertificates(home, u.Hostname())
	case "service":
		if len(positional) != 1 {
			return errors.New("usage: linkos service install|uninstall --home DIR")
		}
		return runtimeService(positional[0], home, file)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func initializeRuntime(home, file string, flags, overrides map[string]string) error {
	if _, err := os.Stat(file); err == nil {
		return fmt.Errorf("configuration already exists: %s", file)
	} else if !os.IsNotExist(err) {
		return err
	}
	c := defaultConfig(home)
	c.AdminPasscode = randomSecret()
	if flags["dev"] == "true" {
		c.Environment = "development"
	}
	if flags["lan"] == "true" {
		host := flags["host"]
		if host == "" || strings.ContainsAny(host, "/:\\ ") && net.ParseIP(host) == nil {
			return errors.New("--lan requires --host IP_OR_DNS")
		}
		if err := createLANCertificates(home, host); err != nil {
			return err
		}
		c.Listen = "0.0.0.0:8787"
		c.PublicURL = "https://" + net.JoinHostPort(host, "8787")
		c.TLSMode = "direct"
		c.TLSCertFile = filepath.Join(home, "tls", "server.crt")
		c.TLSKeyFile = filepath.Join(home, "tls", "server.key")
	}
	c.AllowedOrigins = c.PublicURL
	for key, field := range configFields(&c) {
		if value, ok := os.LookupEnv(key); ok {
			*field = value
		}
		if value, ok := overrides[key]; ok {
			*field = value
		}
	}
	if _, ok := overrides["LINKOS_ALLOWED_ORIGINS"]; !ok && os.Getenv("LINKOS_ALLOWED_ORIGINS") == "" {
		c.AllowedOrigins = c.PublicURL
	}
	if err := c.validate(); err != nil {
		return err
	}
	if err := writePrivateJSON(file, c); err != nil {
		return err
	}
	if err := os.MkdirAll(c.UploadDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(home, "ADMIN-PASSCODE.txt"), []byte(c.AdminPasscode+"\n"), 0600); err != nil {
		return err
	}
	fmt.Printf("Initialized %s\nURL: %s\nAdministrator passcode: %s\n", file, c.PublicURL, filepath.Join(home, "ADMIN-PASSCODE.txt"))
	return nil
}

func serveRuntime(home string, c runtimeConfig) error {
	if err := checkAssets(); err != nil {
		return fmt.Errorf("resources: %w", err)
	}
	if c.TLSMode == "direct" {
		if err := checkTLS(c); err != nil {
			return err
		}
	}
	lock, err := acquireDataLock(c.DataDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := prepareMigrationBackup(home, c); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(home, "logs"), 0700); err != nil {
		return err
	}
	output, err := os.OpenFile(filepath.Join(home, "logs", "gateway.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	log.SetOutput(io.MultiWriter(os.Stderr, output))
	defer log.SetOutput(os.Stderr)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// The private controller never uses the public LAN listener or proxy.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	state := runtimeState{PID: os.Getpid(), InstanceID: randomSecret(), ProjectID: c.ProjectID, URL: c.PublicURL, ControlURL: "http://" + listener.Addr().String(), ControlToken: randomSecret(), Version: buildVersion}
	currentRuntime = state
	controller := &http.Server{ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+state.ControlToken {
			w.WriteHeader(403)
			return
		}
		switch r.URL.Path {
		case "/status":
			writeJSON(w, 200, map[string]string{"instanceId": state.InstanceID})
		case "/stop":
			if r.Method != "POST" {
				w.WriteHeader(405)
				return
			}
			writeJSON(w, 200, map[string]string{"status": "stopping"})
			cancel()
		default:
			http.NotFound(w, r)
		}
	})}
	go controller.Serve(listener)
	defer controller.Close()
	if err = writePrivateJSON(filepath.Join(home, "run.json"), state); err != nil {
		return err
	}
	defer os.Remove(filepath.Join(home, "run.json"))
	return runAsService(func() error { return runGateway(ctx) }, cancel)
}

func readRuntimeState(home string) (runtimeState, error) {
	var s runtimeState
	raw, e := os.ReadFile(filepath.Join(home, "run.json"))
	if e == nil {
		e = json.Unmarshal(raw, &s)
	}
	return s, e
}
func controlRequest(s runtimeState, action string) error {
	u, e := url.Parse(s.ControlURL)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		return errors.New("invalid controller address")
	}
	method := "GET"
	if action == "stop" {
		method = "POST"
	}
	r, e := http.NewRequest(method, s.ControlURL+"/"+action, nil)
	if e != nil {
		return e
	}
	r.Header.Set("Authorization", "Bearer "+s.ControlToken)
	resp, e := (&http.Client{Timeout: 3 * time.Second}).Do(r)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("controller refused request")
	}
	return nil
}

func registerRuntimeRoutes(mux *http.ServeMux, backend persistBackend) {
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, r *http.Request) {
		result := map[string]interface{}{"status": "ok", "service": "gateway", "version": buildVersion, "commit": buildCommit, "instanceId": currentRuntime.InstanceID, "storage": "sqlite"}
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if isLocalDevelopmentPeer(host) && activeConfig.Environment == "development" {
			result["projectId"] = activeConfig.ProjectID
		}
		writeJSON(w, 200, result)
	})
	mux.HandleFunc("/api/v1/readyz", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := backend.(*sqliteBackend); ok {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if e := b.db.PingContext(ctx); e != nil {
				writeJSON(w, 503, map[string]string{"status": "database unavailable"})
				return
			}
		}
		for _, dir := range []string{activeConfig.UploadDir, filepath.Join(activeConfig.UploadDir, "objects")} {
			file, e := os.CreateTemp(dir, ".ready-*")
			if e != nil {
				writeJSON(w, 503, map[string]string{"status": "file storage unavailable"})
				return
			}
			name := file.Name()
			file.Close()
			os.Remove(name)
		}
		if e := checkAssets(); e != nil {
			writeJSON(w, 503, map[string]string{"status": "resources unavailable"})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"status": "ready", "version": buildVersion, "databaseSchema": len(sqliteMigrations), "capabilities": map[string]bool{"embeddedWeb": bundledAssets != nil, "runner": activeConfig.RunnerURL != "", "persistent": true, "developmentWeb": activeConfig.DevUpstream != "" && devUpstreamReady()}})
	})
}

func runtimeDeadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/uploads/") {
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Minute))
		}
		next.ServeHTTP(w, r)
	})
}
