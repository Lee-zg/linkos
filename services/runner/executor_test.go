package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestArtifactCollectionIsBoundedAndPathSafe(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "report.txt"), []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	items := collectArtifacts(root, []string{"report.txt", "../secret", "/tmp/*"})
	if len(items) != 1 || items[0].Name != "report.txt" || items[0].Size != 2 || items[0].Content == "" {
		t.Fatalf("unexpected artifacts: %+v", items)
	}
}

func TestProductionAPITokenIsSeparateFromRegistration(t *testing.T) {
	t.Setenv("LINKOS_ENV", "production")
	t.Setenv("LINKOS_RUNNER_REGISTRATION_TOKEN", "bootstrap-only")
	t.Setenv("LINKOS_RUNNER_API_TOKEN", "")
	if runnerAPIToken() != "" {
		t.Fatal("registration token granted job API access")
	}
	t.Setenv("LINKOS_RUNNER_API_TOKEN", "api-only")
	if runnerAPIToken() != "api-only" {
		t.Fatal("API token ignored")
	}
}
func TestRemoteEngineIsRefused(t *testing.T) {
	t.Setenv("LINKOS_ENV", "production")
	t.Setenv("DOCKER_HOST", "tcp://remote:2376")
	if _, e := newRunnerService().engine(); e == nil {
		t.Fatal("remote engine accepted")
	}
}
