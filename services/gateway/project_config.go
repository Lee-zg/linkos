package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Project configuration contains preferences only. Runtime secrets remain in home/linkos.json.
type projectPort string

func (p *projectPort) UnmarshalJSON(raw []byte) error {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		var number json.Number
		if err := json.Unmarshal(raw, &number); err != nil {
			return errors.New("port must be auto, 0, or an integer from 1 to 65535")
		}
		value = number.String()
	}
	if value != "auto" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != value {
			return errors.New("port must be auto, 0, or an integer from 1 to 65535")
		}
	}
	*p = projectPort(value)
	return nil
}

func (p projectPort) number() int { n, _ := strconv.Atoi(string(p)); return n }

type projectConfig struct {
	Schema        string `json:"$schema,omitempty"`
	SchemaVersion int    `json:"schemaVersion"`
	Tools         struct {
		Node        string `json:"node"`
		Go          string `json:"go"`
		PNPMVersion string `json:"pnpmVersion"`
	} `json:"tools"`
	Dev struct {
		Home       string      `json:"home"`
		Host       string      `json:"host"`
		Port       projectPort `json:"port"`
		LANIP      string      `json:"lanIP"`
		PublicHost string      `json:"publicHost"`
		HTTPS      bool        `json:"https"`
		VitePort   projectPort `json:"vitePort"`
	} `json:"dev"`
	Pack struct {
		OutDir  string   `json:"outDir"`
		Targets []string `json:"targets"`
	} `json:"pack"`
}

type projectOptions struct {
	Root       string        `json:"root"`
	File       string        `json:"file"`
	Config     projectConfig `json:"config"`
	Command    string        `json:"command"`
	Action     string        `json:"action"`
	Acceptance bool          `json:"acceptance"`
	JSON       bool          `json:"json"`
	Follow     bool          `json:"follow"`
	Version    string        `json:"version"`
	Warnings   []string      `json:"warnings"`
}

func defaultProjectConfig() projectConfig {
	var c projectConfig
	c.SchemaVersion = 1
	c.Tools.Node, c.Tools.Go, c.Tools.PNPMVersion = "node", "go", "9.15.5"
	c.Dev.Home, c.Dev.Host, c.Dev.Port = ".local/linkos", "auto", "auto"
	c.Dev.LANIP, c.Dev.PublicHost, c.Dev.HTTPS, c.Dev.VitePort = "auto", "auto", true, "auto"
	c.Pack.OutDir, c.Pack.Targets = "release", []string{"windows/amd64", "linux/amd64", "linux/arm64"}
	return c
}

func strictJSON(raw []byte, target interface{}) error {
	var shape map[string]interface{}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return err
	}
	if shape == nil || shape["schemaVersion"] == nil {
		return errors.New("project configuration requires schemaVersion")
	}
	var containsNull func(interface{}) bool
	containsNull = func(value interface{}) bool {
		switch v := value.(type) {
		case nil:
			return true
		case map[string]interface{}:
			for _, child := range v {
				if containsNull(child) {
					return true
				}
			}
		case []interface{}:
			for _, child := range v {
				if containsNull(child) {
					return true
				}
			}
		}
		return false
	}
	if containsNull(shape) {
		return errors.New("project configuration fields cannot be null")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if err := d.Decode(new(interface{})); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func findProject(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "scripts", "dev.mjs")); err == nil {
			if _, err = os.Stat(filepath.Join(dir, "go.work")); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("LinkOS source project not found; use --project DIR (runtime commands do not need a source checkout)")
}

func loadProjectFile(root, file string) (projectConfig, error) {
	c := defaultProjectConfig()
	raw, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		return c, err
	}
	if err == nil {
		if err = strictJSON(raw, &c); err != nil {
			return c, fmt.Errorf("%s: %w", file, err)
		}
	}
	return c, validateProjectConfig(c)
}

func validateProjectConfig(c projectConfig) error {
	if c.SchemaVersion != 1 {
		return errors.New("unsupported project schemaVersion; expected 1")
	}
	if strings.TrimSpace(c.Tools.Node) == "" || strings.TrimSpace(c.Tools.Go) == "" || c.Tools.PNPMVersion != "9.15.5" {
		return errors.New("tools require node/go executables and pnpmVersion 9.15.5")
	}
	if c.Dev.Home == "" || c.Pack.OutDir == "" {
		return errors.New("dev.home and pack.outDir cannot be empty")
	}
	for _, p := range []projectPort{c.Dev.Port, c.Dev.VitePort} {
		var checked projectPort
		raw, _ := json.Marshal(p)
		if err := json.Unmarshal(raw, &checked); err != nil {
			return err
		}
	}
	host := c.Dev.Host
	if host != "auto" && host != "localhost" && net.ParseIP(host).To4() == nil {
		return errors.New("dev.host must be auto, localhost or a local IPv4")
	}
	if c.Dev.LANIP != "auto" && net.ParseIP(c.Dev.LANIP).To4() == nil {
		return errors.New("dev.lanIP must be auto or a local IPv4")
	}
	if c.Dev.PublicHost != "auto" {
		u, err := url.Parse("https://" + c.Dev.PublicHost)
		if err != nil || u.Hostname() != c.Dev.PublicHost || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(c.Dev.PublicHost, " :/\\\t\n") {
			return errors.New("dev.publicHost must be a DNS hostname or local IPv4, without scheme or port")
		}
		if net.ParseIP(c.Dev.PublicHost) == nil {
			for _, label := range strings.Split(c.Dev.PublicHost, ".") {
				if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
					return errors.New("invalid dev.publicHost DNS name")
				}
				for _, r := range label {
					if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
						return errors.New("invalid dev.publicHost DNS name")
					}
				}
			}
		}
	}
	if len(c.Pack.Targets) == 0 {
		return errors.New("pack.targets cannot be empty")
	}
	seen := map[string]bool{}
	for _, target := range c.Pack.Targets {
		if target != "current" && target != "windows/amd64" && target != "linux/amd64" && target != "linux/arm64" {
			return fmt.Errorf("unsupported target %q", target)
		}
		if seen[target] {
			return errors.New("duplicate pack target")
		}
		seen[target] = true
	}
	return nil
}

func projectArguments(args []string) (map[string]string, []string, error) {
	flags, words := map[string]string{}, []string{}
	bools := map[string]bool{"acceptance": true, "json": true, "follow": true, "help": true, "runtime": true}
	values := map[string]bool{"project": true, "project-config": true, "port": true, "web-port": true, "gateway-port": true, "vite-port": true, "host": true, "lan-ip": true, "public-host": true, "https": true, "home": true, "node": true, "go": true, "version": true, "target": true, "out-dir": true, "install-dir": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			continue
		}
		if a == "-h" {
			a = "--help"
		}
		if !strings.HasPrefix(a, "--") {
			words = append(words, a)
			continue
		}
		key, value, has := strings.Cut(strings.TrimPrefix(a, "--"), "=")
		if !bools[key] && !values[key] {
			return nil, nil, fmt.Errorf("unknown option --%s", key)
		}
		if bools[key] {
			if !has {
				value = "true"
			}
			if value != "true" && value != "false" {
				return nil, nil, fmt.Errorf("--%s requires true or false", key)
			}
		} else if !has {
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "--") {
				return nil, nil, fmt.Errorf("--%s requires a value", key)
			}
			value = args[i]
		}
		flags[key] = value
	}
	return flags, words, nil
}

func resolveProject(args []string) (projectOptions, map[string]string, []string, error) {
	var o projectOptions
	f, w, err := projectArguments(args)
	if err != nil {
		return o, f, w, err
	}
	cwd, _ := os.Getwd()
	start := cwd
	if f["project"] != "" {
		start = f["project"]
	}
	o.Root, err = findProject(start)
	if err != nil {
		return o, f, w, err
	}
	o.File = f["project-config"]
	if o.File == "" {
		o.File = filepath.Join(o.Root, "linkos.config.json")
	}
	o.File, err = filepath.Abs(o.File)
	if err != nil {
		return o, f, w, err
	}
	if f["project-config"] != "" {
		if _, err = os.Stat(o.File); err != nil {
			return o, f, w, fmt.Errorf("project configuration: %w", err)
		}
	}
	o.Config, err = loadProjectFile(o.Root, o.File)
	if err != nil {
		return o, f, w, err
	}
	o.Command = "dev"
	if len(w) > 0 {
		o.Command = w[0]
	}
	if len(w) > 1 {
		o.Action = w[1]
	}
	o.Acceptance = f["acceptance"] == "true"
	o.JSON = f["json"] == "true"
	o.Follow = f["follow"] == "true"
	c := &o.Config
	// Acceptance defaults must never select the normal workspace or public listener.
	if o.Acceptance {
		c.Dev.Home = ".local/acceptance"
		c.Dev.Host = "127.0.0.1"
		c.Dev.HTTPS = false
	}
	fields := map[string]*string{"LINKOS_NODE": &c.Tools.Node, "LINKOS_GO": &c.Tools.Go, "LINKOS_DEV_HOME": &c.Dev.Home, "LINKOS_WEB_HOST": &c.Dev.Host, "LINKOS_LAN_IP": &c.Dev.LANIP, "LINKOS_PUBLIC_HOST": &c.Dev.PublicHost, "LINKOS_RELEASE_DIR": &c.Pack.OutDir}
	for env, field := range fields {
		if value, ok := os.LookupEnv(env); ok {
			*field = value
		}
	}
	for key, field := range map[string]*string{"node": &c.Tools.Node, "go": &c.Tools.Go, "home": &c.Dev.Home, "host": &c.Dev.Host, "lan-ip": &c.Dev.LANIP, "public-host": &c.Dev.PublicHost, "out-dir": &c.Pack.OutDir} {
		if v, ok := f[key]; ok {
			*field = v
		}
	}
	var envOld, cliOld []string
	for _, key := range []string{"LINKOS_WEB_PORT", "LINKOS_GATEWAY_PORT"} {
		if v, ok := os.LookupEnv(key); ok {
			envOld = append(envOld, v)
		}
	}
	for _, key := range []string{"web-port", "gateway-port"} {
		if v, ok := f[key]; ok {
			cliOld = append(cliOld, v)
		}
	}
	legacy := envOld
	if len(envOld) > 0 || len(cliOld) > 0 {
		o.Warnings = append(o.Warnings, "--web-port/--gateway-port and LINKOS_WEB_PORT/LINKOS_GATEWAY_PORT are deprecated; use --port or LINKOS_DEV_PORT")
	}
	port := string(c.Dev.Port)
	if v, ok := os.LookupEnv("LINKOS_DEV_PORT"); ok {
		port = v
		legacy = nil
	}
	if len(cliOld) > 0 {
		legacy = cliOld
	}
	if v, ok := f["port"]; ok {
		port = v
		legacy = nil
	}
	if len(legacy) > 1 && legacy[0] != legacy[1] {
		return o, f, w, errors.New("legacy Web/Gateway ports disagree: the unified entry has one port; use --port PORT")
	}
	if len(legacy) > 0 {
		port = legacy[0]
	}
	raw, _ := json.Marshal(port)
	if err = json.Unmarshal(raw, &c.Dev.Port); err != nil {
		return o, f, w, err
	}
	vite := string(c.Dev.VitePort)
	if v, ok := os.LookupEnv("LINKOS_VITE_PORT"); ok {
		vite = v
	}
	if v, ok := f["vite-port"]; ok {
		vite = v
	}
	raw, _ = json.Marshal(vite)
	if err = json.Unmarshal(raw, &c.Dev.VitePort); err != nil {
		return o, f, w, err
	}
	secure := strconv.FormatBool(c.Dev.HTTPS)
	if v, ok := os.LookupEnv("LINKOS_DEV_HTTPS"); ok {
		secure = v
	}
	if v, ok := f["https"]; ok {
		secure = v
	}
	c.Dev.HTTPS, err = strconv.ParseBool(secure)
	if err != nil {
		return o, f, w, errors.New("https must be true or false")
	}
	if target := os.Getenv("LINKOS_TARGET"); target != "" {
		c.Pack.Targets = strings.Split(target, ",")
	}
	if target, ok := f["target"]; ok {
		c.Pack.Targets = strings.Split(target, ",")
	}
	o.Version = os.Getenv("LINKOS_VERSION")
	if o.Version == "" {
		o.Version = "0.1.0-dev"
	}
	if v, ok := f["version"]; ok {
		o.Version = v
	}
	if err = validateProjectConfig(*c); err != nil {
		return o, f, w, err
	}
	base := filepath.Dir(o.File)
	if c.Tools.Node == "node" && os.Getenv("LINKOS_BOOTSTRAP_NODE") != "" && f["node"] == "" && os.Getenv("LINKOS_NODE") == "" {
		c.Tools.Node = os.Getenv("LINKOS_BOOTSTRAP_NODE")
	}
	for _, p := range []*string{&c.Dev.Home, &c.Pack.OutDir} {
		if !filepath.IsAbs(*p) {
			*p = filepath.Join(base, *p)
		}
	}
	for _, p := range []*string{&c.Tools.Node, &c.Tools.Go} {
		if strings.ContainsAny(*p, "/\\") && !filepath.IsAbs(*p) {
			*p = filepath.Join(base, *p)
		}
	}
	for i, target := range c.Pack.Targets {
		if target == "current" {
			c.Pack.Targets[i] = runtime.GOOS + "/" + runtime.GOARCH
		}
	}
	return o, f, w, nil
}
