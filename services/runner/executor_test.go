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
