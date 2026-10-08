package main

import "os"

func runnerRequestToken() string {
	if value := os.Getenv("LINKOS_RUNNER_API_TOKEN"); value != "" {
		return value
	}
	if os.Getenv("LINKOS_ENV") != "production" {
		return os.Getenv("LINKOS_RUNNER_REGISTRATION_TOKEN")
	}
	return ""
}
