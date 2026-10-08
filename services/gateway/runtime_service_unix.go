//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func runAsService(run func() error, cancel context.CancelFunc) error { return run() }
func runtimeService(action, home, config string) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("service installation supports Windows and Linux")
	}
	userHome, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	dir := filepath.Join(userHome, ".config", "systemd", "user")
	unit := filepath.Join(dir, "linkos.service")
	systemctl := func(args ...string) error {
		cmd := exec.Command("systemctl", append([]string{"--user"}, args...)...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	switch action {
	case "install":
		if _, e = os.Stat(unit); e == nil {
			return fmt.Errorf("service already installed")
		}
		binary, e := os.Executable()
		if e != nil {
			return e
		}
		quote := func(v string) string {
			return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "$$", "\n", "\\n").Replace(v) + "\""
		}
		if e = os.MkdirAll(dir, 0700); e != nil {
			return e
		}
		raw := "[Unit]\nDescription=LinkOS workspace\nAfter=network.target\n[Service]\nExecStart=" + quote(binary) + " serve --home " + quote(home) + " --config " + quote(config) + "\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n"
		if e = os.WriteFile(unit, []byte(raw), 0600); e != nil {
			return e
		}
		if e = systemctl("daemon-reload"); e != nil {
			_ = os.Remove(unit)
			return e
		}
		if e = systemctl("enable", "linkos.service"); e != nil {
			_ = os.Remove(unit)
			_ = systemctl("daemon-reload")
			return e
		}
		return nil
	case "uninstall":
		if e = systemctl("disable", "--now", "linkos.service"); e != nil {
			return e
		}
		if e = os.Remove(unit); e != nil {
			return e
		}
		return systemctl("daemon-reload")
	default:
		return fmt.Errorf("service expects install or uninstall")
	}
}
