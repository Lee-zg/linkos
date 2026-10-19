//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func updateUserCLIPath(dir string, add bool) error {
	if add {
		for _, p := range filepath.SplitList(os.Getenv("PATH")) {
			if p == dir {
				return nil
			}
		}
		fmt.Printf("Add the user command directory to your shell PATH: export PATH=\"%s:$PATH\"\n", dir)
	}
	return nil
}
