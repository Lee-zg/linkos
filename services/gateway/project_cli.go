package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const cliHelp = `LinkOS — development, delivery and workspace maintenance

  dev [status|logs|stop]   Start (prepare automatically), inspect or stop owned development services
  setup                    Prepare dependencies and a persistent development workspace
  doctor [--runtime]        Read-only environment diagnostics; --json for automation
  config show|get|set|validate
  pack [--version VERSION] [--target current|windows/amd64,linux/amd64,linux/arm64]
  cli install|uninstall    Explicit user-level command installation
  init|serve|status|logs|stop|backup|restore|tls|service|version

Project options: --project DIR --project-config FILE --json
Development: --port auto|PORT --host auto|127.0.0.1|0.0.0.0 --lan-ip IP --public-host DNS --acceptance
Runtime: --home DIR --config FILE (runtime linkos.json)
Examples: linkos config set dev.port auto; linkos dev; linkos pack --target current
`

func dispatchProjectCLI(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	// Global project options are accepted before or after the subcommand.
	for i := 0; i < len(args); i++ {
		if args[i] == "--json" {
			continue
		}
		if args[i] == "--project" || args[i] == "--project-config" {
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--project=") || strings.HasPrefix(args[i], "--project-config=") {
			continue
		}
		if i > 0 && !strings.HasPrefix(args[i], "-") {
			args = append([]string{args[i]}, append(append([]string{}, args[:i]...), args[i+1:]...)...)
		}
		break
	}
	command := args[0]
	for _, a := range args {
		if a == "--help" || a == "-h" {
			fmt.Print(cliHelp)
			return true, nil
		}
	}
	if command == "help" || command == "--help" || command == "-h" {
		fmt.Print(cliHelp)
		return true, nil
	}
	if command == "doctor" {
		for _, a := range args[1:] {
			if a == "--runtime" || a == "--runtime=true" || a == "--home" || strings.HasPrefix(a, "--home=") || a == "--config" || strings.HasPrefix(a, "--config=") {
				return true, runtimeDoctor(args[1:])
			}
		}
	}
	if command != "dev" && command != "setup" && command != "pack" && command != "config" && command != "cli" && command != "doctor" && command != "_project" {
		return false, nil
	}
	if command == "cli" && len(args) > 1 && args[1] == "uninstall" {
		return true, uninstallUserCLI(args[2:])
	}
	if command == "cli" && len(args) > 1 && args[1] == "install" && bundledAssets != nil {
		f, w, e := projectArguments(args)
		if e != nil {
			return true, e
		}
		if len(w) != 2 {
			return true, errors.New("usage: cli install")
		}
		return true, installUserCLI(projectOptions{}, f["install-dir"])
	}
	internal := command == "_project"
	if internal {
		args = args[1:]
	}
	o, f, w, err := resolveProject(args)
	if err != nil {
		if command == "doctor" {
			if bundledAssets != nil && o.Root == "" && f["project"] == "" && f["project-config"] == "" {
				return true, runtimeDoctor(args[1:])
			}
			return true, projectDoctorFailure(args, err)
		}
		return true, err
	}
	if internal {
		return true, json.NewEncoder(os.Stdout).Encode(o)
	}
	if f["help"] == "true" {
		fmt.Print(cliHelp)
		return true, nil
	}
	for _, warning := range o.Warnings {
		fmt.Fprintln(os.Stderr, "Warning:", warning)
	}
	switch command {
	case "config":
		return true, projectConfigCommand(o, w)
	case "doctor":
		return true, projectDoctor(o)
	case "cli":
		if len(w) != 2 || w[1] != "install" {
			return true, errors.New("usage: linkos cli install|uninstall")
		}
		return true, installUserCLI(o, f["install-dir"])
	case "dev":
		if len(w) > 2 || o.Action != "" && o.Action != "status" && o.Action != "logs" && o.Action != "stop" {
			return true, errors.New("usage: linkos dev [status|logs|stop]")
		}
	case "setup", "pack":
		if len(w) != 1 {
			return true, fmt.Errorf("unexpected arguments for %s", command)
		}
	}
	return true, runProjectAdapter(o)
}

func projectConfigCommand(o projectOptions, words []string) error {
	if len(words) < 2 {
		return errors.New("usage: config show|get KEY|set KEY VALUE|validate")
	}
	c, err := loadProjectFile(o.Root, o.File)
	if err != nil {
		return err
	}
	if words[1] == "validate" && len(words) == 2 {
		return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"valid": true, "file": o.File})
	}
	if words[1] == "show" && len(words) == 2 {
		return json.NewEncoder(os.Stdout).Encode(o)
	}
	if len(words) < 3 {
		return errors.New("config get/set requires a dotted key")
	}
	raw, _ := json.Marshal(c)
	var obj map[string]interface{}
	json.Unmarshal(raw, &obj)
	keys := strings.Split(words[2], ".")
	var value interface{} = obj
	for _, key := range keys {
		m, ok := value.(map[string]interface{})
		if !ok {
			return fmt.Errorf("unknown config key %s", words[2])
		}
		var exists bool
		value, exists = m[key]
		if !exists {
			return fmt.Errorf("unknown config key %s", words[2])
		}
	}
	if words[1] == "get" && len(words) == 3 {
		return json.NewEncoder(os.Stdout).Encode(value)
	}
	if words[1] != "set" || len(words) != 4 {
		return errors.New("usage: config set KEY VALUE (JSON arrays/booleans/numbers or plain strings)")
	}
	var replacement interface{}
	if json.Unmarshal([]byte(words[3]), &replacement) != nil {
		replacement = words[3]
	}
	parent := obj
	for _, key := range keys[:len(keys)-1] {
		parent = parent[key].(map[string]interface{})
	}
	parent[keys[len(keys)-1]] = replacement
	raw, err = json.Marshal(obj)
	if err != nil {
		return err
	}
	checked := defaultProjectConfig()
	if err = strictJSON(raw, &checked); err != nil {
		return err
	}
	if err = validateProjectConfig(checked); err != nil {
		return err
	}
	if err = writePrivateJSON(o.File, checked); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"saved": o.File, "restartRequired": true})
}

func runProjectAdapter(o projectOptions) error {
	script := "dev.mjs"
	if o.Command == "pack" {
		script = "release.mjs"
	}
	raw, _ := json.Marshal(o)
	binary, _ := os.Executable()
	cmd := exec.Command(o.Config.Tools.Node, filepath.Join(o.Root, "scripts", script))
	cmd.Dir = o.Root
	cmd.Env = append(os.Environ(), "LINKOS_CLI_OPTIONS="+string(raw), "LINKOS_CLI_BINARY="+binary)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Node adapter: %w; run linkos doctor", err)
	}
	// Console Ctrl+C also reaches Node on Windows. On Unix forward it explicitly.
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case err := <-done:
			return err
		case s := <-signals:
			if o.Command == "dev" && o.Action == "" {
				_ = stopDevelopment(o.Config.Dev.Home, cmd.Process.Pid)
			} else {
				_ = cmd.Process.Signal(s)
			}
		}
	}
}

type developmentControl struct {
	ProjectID   string `json:"projectId"`
	InstanceID  string `json:"instanceId"`
	URL         string `json:"url"`
	Token       string `json:"token"`
	LauncherPID int    `json:"launcherPID"`
}

func stopDevelopment(home string, launcherPID int) error {
	raw, err := os.ReadFile(filepath.Join(home, "dev-control.json"))
	if err != nil {
		return err
	}
	var c developmentControl
	if err = json.Unmarshal(raw, &c); err != nil {
		return err
	}
	if c.LauncherPID != launcherPID {
		return errors.New("controller belongs to another launcher; reused services were left running")
	}
	if !strings.HasPrefix(c.URL, "http://127.0.0.1:") {
		return errors.New("invalid development controller")
	}
	r, err := http.NewRequest("POST", c.URL+"/stop", nil)
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+c.Token)
	r.Header.Set("X-LinkOS-Instance", c.InstanceID)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("development controller refused stop")
	}
	return nil
}

func runtimeDoctor(args []string) error {
	clean := []string{}
	asJSON := false
	for _, a := range args {
		if a == "--runtime" || a == "--runtime=true" {
			continue
		}
		if a == "--json" {
			asJSON = true
			continue
		}
		clean = append(clean, a)
	}
	f, _, err := parseRuntimeArgs(clean)
	if err != nil {
		return err
	}
	home := f["home"]
	if home == "" {
		home = defaultHome()
	}
	home, _ = filepath.Abs(home)
	file := f["config"]
	if file == "" {
		file = filepath.Join(home, "linkos.json")
	}
	report := doctorReport{Checks: []doctorCheck{}}
	c, err := readRuntimeConfig(home, file, nil)
	report.add("config", err, "Check runtime linkos.json and environment overrides")
	if err == nil {
		prior := activeConfig
		activeConfig = c
		defer func() { activeConfig = prior }()
		report.add("assets", checkAssets(), "Use an embedded release or configure webDir")
		if c.TLSMode == "direct" {
			report.add("TLS", checkTLS(c), "Check certificate validity, key and publicURL")
		}
		state, e := readRuntimeState(home)
		if e == nil {
			report.add("instance", controlRequest(state, "status"), "Inspect stale instance registration")
		} else {
			report.warn("instance", "offline", "Start linkos serve when needed")
		}
		report.warn("runner", map[bool]string{true: "configured", false: "disabled (optional)"}[c.RunnerURL != ""], "")
	}
	return report.print(asJSON)
}

// Kept here so log following does not require Node in a deployed workspace.
func followRuntimeLog(ctx context.Context, file string, output io.Writer) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	_, _ = f.Seek(0, io.SeekEnd)
	reader := bufio.NewReader(f)
	for {
		line, e := reader.ReadString('\n')
		if len(line) > 0 {
			fmt.Fprint(output, line)
		}
		if e != nil && e != io.EOF {
			return e
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(200 * time.Millisecond):
		}
	}
}
