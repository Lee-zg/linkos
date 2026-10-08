package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

func rootlessEngine(engine string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if engine == "docker" {
		host, e := exec.CommandContext(ctx, "docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}").Output()
		if e != nil || !strings.HasPrefix(strings.Trim(string(host), "\"\r\n"), "unix://") {
			return false
		}
		raw, e := exec.CommandContext(ctx, "docker", "info", "--format", "{{json .SecurityOptions}}").Output()
		return e == nil && strings.Contains(string(raw), "rootless")
	}
	raw, e := exec.CommandContext(ctx, "podman", "info", "--format", "json").Output()
	if e != nil {
		return false
	}
	var data struct {
		Host struct {
			Security struct {
				Rootless bool `json:"rootless"`
			} `json:"security"`
		} `json:"host"`
	}
	return json.Unmarshal(raw, &data) == nil && data.Host.Security.Rootless
}
