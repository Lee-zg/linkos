package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

var buildVersion = "dev"
var buildCommit = "unknown"
var activeConfig runtimeConfig
var activeHome string

type runtimeConfig struct {
	SchemaVersion     int    `json:"schemaVersion"`
	Environment       string `json:"environment"`
	Listen            string `json:"listen"`
	PublicURL         string `json:"publicURL"`
	DataDir           string `json:"dataDir"`
	UploadDir         string `json:"uploadDir"`
	PluginDir         string `json:"pluginDir,omitempty"`
	WebDir            string `json:"webDir,omitempty"`
	TLSMode           string `json:"tlsMode"`
	TLSCertFile       string `json:"tlsCertFile,omitempty"`
	TLSKeyFile        string `json:"tlsKeyFile,omitempty"`
	AdminPasscode     string `json:"adminPasscode"`
	AllowedOrigins    string `json:"allowedOrigins"`
	RunnerURL         string `json:"runnerURL,omitempty"`
	RunnerAPIToken    string `json:"runnerAPIToken,omitempty"`
	PluginTrustedKeys string `json:"pluginTrustedKeys,omitempty"`
	DiscoveryPort     int    `json:"discoveryPort"`
	ProjectID         string `json:"projectId,omitempty"`
	DevUpstream       string `json:"devUpstream,omitempty"`
}

func defaultHome() string {
	if value := os.Getenv("LINKOS_HOME"); value != "" {
		return value
	}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("LOCALAPPDATA"); value != "" {
			return filepath.Join(value, "LinkOS")
		}
	}
	if value := os.Getenv("XDG_DATA_HOME"); value != "" {
		return filepath.Join(value, "linkos")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "linkos")
}

func defaultConfig(home string) runtimeConfig {
	return runtimeConfig{SchemaVersion: 1, Environment: "production", Listen: "127.0.0.1:8787", PublicURL: "http://127.0.0.1:8787", DataDir: filepath.Join(home, "data"), UploadDir: filepath.Join(home, "data", "uploads"), TLSMode: "local", AllowedOrigins: "http://127.0.0.1:8787", DiscoveryPort: 8788}
}

func configFields(c *runtimeConfig) map[string]*string {
	return map[string]*string{"LINKOS_DEV_UPSTREAM": &c.DevUpstream, "LINKOS_ENV": &c.Environment, "LINKOS_LISTEN": &c.Listen, "LINKOS_PUBLIC_URL": &c.PublicURL, "LINKOS_DATA_DIR": &c.DataDir, "LINKOS_UPLOAD_DIR": &c.UploadDir, "LINKOS_PLUGIN_DIR": &c.PluginDir, "LINKOS_WEB_DIR": &c.WebDir, "LINKOS_TLS_MODE": &c.TLSMode, "LINKOS_TLS_CERT_FILE": &c.TLSCertFile, "LINKOS_TLS_KEY_FILE": &c.TLSKeyFile, "LINKOS_ADMIN_PASSCODE": &c.AdminPasscode, "LINKOS_ALLOWED_ORIGINS": &c.AllowedOrigins, "LINKOS_RUNNER_URL": &c.RunnerURL, "LINKOS_RUNNER_API_TOKEN": &c.RunnerAPIToken, "LINKOS_PLUGIN_TRUSTED_KEYS": &c.PluginTrustedKeys, "LINKOS_PROJECT_ID": &c.ProjectID}
}

func readRuntimeConfig(home, file string, overrides map[string]string) (runtimeConfig, error) {
	c := defaultConfig(home)
	raw, err := os.ReadFile(file)
	if err == nil {
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&c); err != nil {
			return c, fmt.Errorf("config: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return c, err
	}
	for key, field := range configFields(&c) {
		if value, exists := os.LookupEnv(key); exists {
			*field = value
		}
		if value, exists := overrides[key]; exists {
			*field = value
		}
	}
	if value := os.Getenv("LINKOS_DISCOVERY_PORT"); value != "" {
		c.DiscoveryPort, err = strconv.Atoi(value)
		if err != nil {
			return c, err
		}
	}
	if value, exists := overrides["LINKOS_DISCOVERY_PORT"]; exists {
		c.DiscoveryPort, err = strconv.Atoi(value)
		if err != nil {
			return c, err
		}
	}
	for _, field := range []*string{&c.DataDir, &c.UploadDir, &c.PluginDir, &c.WebDir, &c.TLSCertFile, &c.TLSKeyFile} {
		if *field != "" && !filepath.IsAbs(*field) {
			*field = filepath.Join(filepath.Dir(file), *field)
		}
	}
	return c, c.validate()
}

func (c runtimeConfig) validate() error {
	if err := validateDevUpstream(c.Environment, c.DevUpstream); err != nil {
		return err
	}
	if c.SchemaVersion != 1 {
		return errors.New("unsupported linkos.json schemaVersion")
	}
	if c.Environment != "production" && c.Environment != "development" {
		return errors.New("environment must be production or development")
	}
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return errors.New("invalid listen port")
	}
	public, err := url.Parse(c.PublicURL)
	if err != nil || public.Hostname() == "" || public.User != nil || public.RawQuery != "" || public.Fragment != "" || public.Path != "" && public.Path != "/" || public.Scheme != "http" && public.Scheme != "https" {
		return errors.New("publicURL must be an http(s) origin")
	}
	if c.DataDir == "" || c.UploadDir == "" {
		return errors.New("dataDir and uploadDir are required")
	}
	if c.DiscoveryPort < 1 || c.DiscoveryPort > 65535 {
		return errors.New("invalid discoveryPort")
	}
	switch c.TLSMode {
	case "local":
		if c.TLSCertFile != "" || c.TLSKeyFile != "" {
			return errors.New("local mode cannot configure TLS files; select direct mode")
		}
		if !isLoopbackHost(host) || !isLoopbackHost(public.Hostname()) || public.Scheme != "http" {
			return errors.New("local mode requires loopback HTTP; use init --lan --host for LAN")
		}
	case "direct":
		if public.Scheme != "https" || c.TLSCertFile == "" || c.TLSKeyFile == "" {
			return errors.New("direct TLS requires HTTPS publicURL, tlsCertFile and tlsKeyFile")
		}
	case "proxy":
		if public.Scheme != "https" || c.TLSCertFile != "" || c.TLSKeyFile != "" {
			return errors.New("proxy TLS requires HTTPS publicURL and no direct TLS files")
		}
		// An explicit proxy mode is only for a private network/loopback deployment.
	default:
		return errors.New("tlsMode must be local, direct or proxy")
	}
	if c.Environment == "production" && (len(c.AdminPasscode) < 24 || c.AdminPasscode == defaultAdminPasscode) {
		return errors.New("production requires a generated or >=24-character adminPasscode; run linkos init")
	}
	for _, origin := range strings.Split(c.AllowedOrigins, ",") {
		parsed, e := url.Parse(strings.TrimSpace(origin))
		if e != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme != "https" && parsed.Scheme != "http" {
			return errors.New("allowedOrigins must list complete http(s) origins")
		}
	}
	if c.RunnerURL != "" {
		u, e := url.Parse(c.RunnerURL)
		if e != nil || u.Hostname() == "" || u.User != nil || u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackHost(u.Hostname())) {
			return errors.New("runnerURL requires HTTPS outside loopback")
		}
		if c.RunnerAPIToken == "" {
			return errors.New("runnerAPIToken required when Runner is enabled")
		}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
}
func randomSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func writePrivateJSON(path string, value interface{}) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".linkos-write-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(append(raw, '\n'))
	}
	closeErr := temp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

func (c runtimeConfig) apply() {
	activeConfig = c
	for key, field := range configFields(&c) {
		_ = os.Setenv(key, *field)
	}
	_ = os.Setenv("LINKOS_DISCOVERY_PORT", strconv.Itoa(c.DiscoveryPort))
}
