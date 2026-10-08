//go:build release

package main

import (
	"embed"
	"io/fs"
)

// Staged by scripts/release.mjs; never embed user data or local configuration.
//
//go:embed all:bundle/web all:bundle/plugins
var releaseAssets embed.FS
var bundledAssets fs.FS = releaseAssets
