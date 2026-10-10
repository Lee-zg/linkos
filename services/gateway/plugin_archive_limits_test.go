package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"testing"
)

func TestPluginArchiveRejectsSymlinksDuplicatesAndLimits(t *testing.T) {
	store, _, _, _ := pluginFixture(t, memoryBackend{})
	cases := []struct {
		name    string
		headers []*zip.FileHeader
	}{
		{"duplicate", []*zip.FileHeader{{Name: "ui/a.js"}, {Name: "ui/a.js"}}},
		{"case conflict", []*zip.FileHeader{{Name: "ui/a.js"}, {Name: "ui/A.js"}}},
		{"oversize", []*zip.FileHeader{{Name: "ui/a.js", UncompressedSize64: maxPluginFile + 1, Method: zip.Deflate}}},
	}
	symlink := &zip.FileHeader{Name: "ui/link"}
	symlink.SetMode(os.ModeSymlink | 0700)
	cases = append(cases, struct {
		name    string
		headers []*zip.FileHeader
	}{"symlink", []*zip.FileHeader{symlink}})
	expanded := []*zip.FileHeader{}
	for i := 0; i < 9; i++ {
		expanded = append(expanded, &zip.FileHeader{Name: fmt.Sprintf("ui/%d", i), UncompressedSize64: 15 * 1024 * 1024, Method: zip.Deflate})
	}
	cases = append(cases, struct {
		name    string
		headers []*zip.FileHeader
	}{"expanded", expanded})
	many := []*zip.FileHeader{}
	for i := 0; i < 1001; i++ {
		many = append(many, &zip.FileHeader{Name: fmt.Sprintf("ui/%d", i)})
	}
	cases = append(cases, struct {
		name    string
		headers []*zip.FileHeader
	}{"count", many})
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var buf bytes.Buffer
			writer := zip.NewWriter(&buf)
			for _, header := range test.headers {
				if _, err := writer.CreateRaw(header); err != nil {
					t.Fatal(err)
				}
			}
			writer.Close()
			if _, err := store.inspectPackage(buf.Bytes(), authPrincipal{Token: "fixture"}); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
