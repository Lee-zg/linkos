package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func validateDevUpstream(environment, address string) error {
	if address == "" {
		return nil
	}
	u, e := url.Parse(address)
	if environment != "development" || e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("devUpstream is allowed only in development and must be an http://127.0.0.1:PORT origin")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("invalid devUpstream port")
	}
	return nil
}

func validateDevCertificateDNS(host string) error {
	if host == "localhost" {
		return nil
	}
	c := defaultProjectConfig()
	c.Dev.PublicHost = host
	return validateProjectConfig(c)
}

func devUpstreamReady() bool {
	if activeConfig.DevUpstream == "" {
		return true
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(activeConfig.DevUpstream + "/__linkos/dev")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return false
	}
	var info struct {
		ProjectID string `json:"projectId"`
	}
	return json.NewDecoder(response.Body).Decode(&info) == nil && info.ProjectID == activeConfig.ProjectID
}

func developmentWebHandler() http.Handler {
	target, _ := url.Parse(activeConfig.DevUpstream)
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) { r.SetURL(target); r.SetXForwarded() }, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "DEVELOPMENT_WEB_UNAVAILABLE", "message": "Vite is unavailable; inspect linkos dev logs"})
	}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/__linkos/") && r.URL.Path != "/__linkos/hmr" {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func registerDevelopmentRoutes(mux *http.ServeMux) {
	if activeConfig.DevUpstream == "" {
		return
	}
	mux.HandleFunc("/__linkos/dev", func(w http.ResponseWriter, r *http.Request) {
		ready := devUpstreamReady()
		status := 200
		if !ready {
			status = 503
		}
		info := map[string]interface{}{"service": "web", "topology": "gateway", "ready": ready, "gatewayURL": os.Getenv("LINKOS_DEV_ENTRY_URL")}
		var lan []string
		_ = json.Unmarshal([]byte(os.Getenv("LINKOS_WEB_LAN_URLS")), &lan)
		info["lanURLs"] = lan
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if isLocalDevelopmentPeer(host) {
			info["projectId"] = activeConfig.ProjectID
		}
		writeJSON(w, status, info)
	})
}

func isLocalDevelopmentPeer(host string) bool {
	return isLoopbackHost(host) || assignedLocalIP(net.ParseIP(host))
}
