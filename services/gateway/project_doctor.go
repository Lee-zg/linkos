package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type doctorCheck struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Message     string `json:"message"`
	Remediation string `json:"remediation,omitempty"`
}
type doctorReport struct {
	Checks []doctorCheck `json:"checks"`
}

func (r *doctorReport) add(id string, err error, fix string) {
	c := doctorCheck{ID: id, Status: "pass", Message: "ok"}
	if err != nil {
		c.Status = "fail"
		c.Message = err.Error()
		c.Remediation = fix
	}
	r.Checks = append(r.Checks, c)
}
func (r *doctorReport) warn(id, message, fix string) {
	r.Checks = append(r.Checks, doctorCheck{ID: id, Status: "warning", Message: message, Remediation: fix})
}
func (r doctorReport) print(asJSON bool) error {
	failed := false
	for _, c := range r.Checks {
		if c.Status == "fail" {
			failed = true
		}
	}
	if asJSON {
		if err := json.NewEncoder(os.Stdout).Encode(r); err != nil {
			return err
		}
	} else {
		for _, c := range r.Checks {
			fmt.Printf("[%s] %s: %s\n", c.Status, c.ID, c.Message)
			if c.Remediation != "" {
				fmt.Printf("  %s\n", c.Remediation)
			}
		}
	}
	if failed {
		return errors.New("environment checks failed; see remediation above")
	}
	return nil
}
func doctorTool(r *doctorReport, id, tool string, args []string, pattern string) {
	p, e := exec.LookPath(tool)
	if e != nil {
		r.add(id, e, "Install/configure the required executable; LinkOS does not install system toolchains")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, p, args...)
	if strings.EqualFold(filepath.Ext(p), ".cmd") || strings.EqualFold(filepath.Ext(p), ".bat") {
		cmd = exec.CommandContext(ctx, "cmd.exe", append([]string{"/d", "/c", p}, args...)...)
	}
	cmd.WaitDelay = 3 * time.Second
	// Bound external tools even when a broken executable hangs.
	raw, e := cmd.CombinedOutput()
	if e == nil && !regexp.MustCompile(pattern).Match(raw) {
		e = fmt.Errorf("unsupported version: %s", strings.TrimSpace(string(raw)))
	}
	r.add(id, e, "Required: Node >=24 stable, Go 1.25/1.26, pnpm 9.15.5")
	if e == nil {
		r.Checks[len(r.Checks)-1].Message = p + ": " + strings.TrimSpace(string(raw))
	}
}
func projectDoctorFailure(args []string, cause error) error {
	r := doctorReport{}
	r.add("project", cause, "Use --project DIR and repair linkos.config.json")
	doctorTool(&r, "node", "node", []string{"--version"}, `^v(2[4-9]|[3-9][0-9])\.[0-9]+\.[0-9]+\s*$`)
	doctorTool(&r, "go", "go", []string{"version"}, `go1\.(25|26)\.`)
	asJSON := false
	for _, a := range args {
		if a == "--json" {
			asJSON = true
		}
	}
	return r.print(asJSON)
}
func projectDoctor(o projectOptions) error {
	r := doctorReport{}
	r.add("config", nil, "")
	doctorTool(&r, "node", o.Config.Tools.Node, []string{"--version"}, `^v(2[4-9]|[3-9][0-9])\.[0-9]+\.[0-9]+\s*$`)
	doctorTool(&r, "go", o.Config.Tools.Go, []string{"version"}, `go1\.(25|26)\.`)
	localPNPM := filepath.Join(o.Root, ".local/tooling/node_modules/pnpm/bin/pnpm.cjs")
	if _, e := os.Stat(localPNPM); e == nil {
		doctorTool(&r, "pnpm", o.Config.Tools.Node, []string{localPNPM, "--version"}, `^9\.15\.5\s*$`)
	} else {
		doctorTool(&r, "pnpm", "pnpm", []string{"--version"}, `^9\.15\.5\s*$`)
	}
	_, e := os.Stat(filepath.Join(o.Root, "apps/web/node_modules/vite/bin/vite.js"))
	r.add("dependencies", e, "Run linkos setup, or linkos dev to prepare automatically")
	for _, dir := range []string{o.Root, o.Config.Dev.Home, o.Config.Pack.OutDir} {
		p := dir
		for {
			info, err := os.Stat(p)
			if err == nil {
				if !info.IsDir() {
					r.add("directory", fmt.Errorf("not a directory: %s", p), "Choose a directory path")
				}
				break
			}
			if !os.IsNotExist(err) {
				r.add("directory", err, "Check directory permissions")
				break
			}
			next := filepath.Dir(p)
			if next == p {
				break
			}
			p = next
		}
	}
	interfaces, e := net.Interfaces()
	r.add("network", e, "")
	if e == nil {
		names := []string{}
		for _, iface := range interfaces {
			if iface.Flags&net.FlagUp != 0 && iface.Flags&net.FlagLoopback == 0 {
				names = append(names, iface.Name)
			}
		}
		r.Checks[len(r.Checks)-1].Message = strings.Join(names, ", ")
	}
	raw, e := os.ReadFile(filepath.Join(o.Config.Dev.Home, "dev.json"))
	if os.IsNotExist(e) {
		r.warn("instance", "offline", "Run linkos dev")
		return r.print(o.JSON)
	}
	r.add("registration", e, "Inspect dev.json")
	if e != nil {
		return r.print(o.JSON)
	}
	var state struct {
		ProjectID  string   `json:"projectId"`
		WebURL     string   `json:"webURL"`
		GatewayURL string   `json:"gatewayURL"`
		CA         string   `json:"webCA"`
		LANURLs    []string `json:"lanURLs"`
	}
	if e = json.Unmarshal(raw, &state); e != nil {
		r.add("registration", e, "Repair stale dev.json")
		return r.print(o.JSON)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if state.CA != "" {
		ca, err := os.ReadFile(state.CA)
		r.add("CA", err, "Check development CA path")
		if err == nil {
			pool.AppendCertsFromPEM(ca)
		}
	}
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	get := func(address string) (map[string]interface{}, error) {
		resp, err := client.Get(address)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		var value map[string]interface{}
		err = json.NewDecoder(resp.Body).Decode(&value)
		return value, err
	}
	_, e = get(state.WebURL + "/__linkos/dev")
	if e != nil {
		r.warn("instance", "offline or stale registration", e.Error())
		return r.print(o.JSON)
	}
	info, e := get(state.GatewayURL + "/api/v1/healthz")
	if e == nil && info["projectId"] != state.ProjectID {
		e = errors.New("project identity mismatch")
	}
	r.add("API/instance", e, "Inspect service ownership; do not stop unrelated processes")
	_, e = get(state.WebURL + "/api/v1/readyz")
	r.add("readiness", e, "Inspect gateway and Vite logs")
	resp, e := client.Get(state.WebURL + "/")
	if resp != nil {
		if e == nil && resp.StatusCode != http.StatusOK {
			e = fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		resp.Body.Close()
	}
	r.add("page", e, "Inspect development proxy")
	u, e := url.Parse(state.WebURL)
	if e == nil {
		u.Path = "/__linkos/hmr"
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		// net/http adds h2 to its TLS configuration. Gorilla uses HTTP/1.1,
		// so its dialers need a separate configuration with explicit ALPN.
		websocketTLS := transport.TLSClientConfig.Clone()
		websocketTLS.NextProtos = []string{"http/1.1"}
		dialer := websocket.Dialer{TLSClientConfig: websocketTLS, HandshakeTimeout: 3 * time.Second, Subprotocols: []string{"vite-hmr"}}
		business := *u
		business.Path = "/api/v1/ws"
		business.RawQuery = ""
		wsCheck, authResponse, authErr := (&websocket.Dialer{TLSClientConfig: websocketTLS, HandshakeTimeout: 3 * time.Second}).Dial(business.String(), http.Header{"Origin": []string{state.WebURL}})
		if wsCheck != nil {
			wsCheck.Close()
		}
		if authResponse != nil && (authResponse.StatusCode == 401 || authResponse.StatusCode == 403) {
			authErr = nil
		}
		if authResponse != nil && authResponse.Body != nil {
			authResponse.Body.Close()
		}
		if authErr == nil && wsCheck != nil {
			authErr = errors.New("business WebSocket accepted an unauthenticated connection")
		}
		r.add("business-websocket-auth", authErr, "Expected authentication rejection; full authenticated connection is covered by browser acceptance")
		// Vite requires its generated token. Read it from the served client module.
		resp, err := client.Get(state.WebURL + "/@vite/client")
		if err == nil {
			var b strings.Builder
			_, err = io.Copy(&b, io.LimitReader(resp.Body, 1024*1024))
			resp.Body.Close()
			if err == nil {
				match := regexp.MustCompile(`const wsToken = "([^"]+)"`).FindStringSubmatch(b.String())
				if len(match) > 1 {
					q := u.Query()
					q.Set("token", match[1])
					u.RawQuery = q.Encode()
				}
			}
		}
		header := http.Header{"Origin": []string{state.WebURL}}
		ws, _, err := dialer.Dial(u.String(), header)
		if ws != nil {
			ws.Close()
		}
		r.add("HMR", err, "Check Gateway HMR forwarding and Vite readiness")
	}
	for _, address := range state.LANURLs {
		parsed, _ := url.Parse(address)
		if parsed == nil {
			continue
		}
		ip := net.ParseIP(parsed.Hostname())
		if ip != nil && !assignedLocalIP(ip) {
			r.warn("LAN", "registered address no longer belongs to this computer: "+parsed.Hostname(), "Network settings refresh on the next normal development start")
		}
	}
	if raw, e := os.ReadFile(filepath.Join(o.Config.Dev.Home, "dev-web/tls/server.crt")); e == nil {
		block, _ := pem.Decode(raw)
		if block != nil {
			cert, err := x509.ParseCertificate(block.Bytes)
			if err == nil && time.Until(cert.NotAfter) < 30*24*time.Hour {
				r.warn("TLS", "development certificate expires within 30 days", "Renew on the next normal start")
			}
		}
	}
	r.warn("runner", "optional; disabled unless configured", "")
	return r.print(o.JSON)
}
func assignedLocalIP(ip net.IP) bool {
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			local, _, _ := net.ParseCIDR(address.String())
			if local.Equal(ip) {
				return true
			}
		}
	}
	return ip.IsLoopback()
}
