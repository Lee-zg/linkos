package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

func pluginRoot() string {
	if root := os.Getenv("LINKOS_PLUGIN_DIR"); root != "" {
		return root
	}
	_, source, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(source), "..", "..", "plugins")
}

func (s *mvpStore) loadBuiltinPluginsLocked() {
	if bundledAssets == nil {
		return
	}
	dirs, err := fs.ReadDir(bundledAssets, "bundle/plugins")
	if err != nil {
		return
	}
	for _, dir := range dirs {
		raw, e := fs.ReadFile(bundledAssets, path.Join("bundle/plugins", dir.Name(), "manifest.json"))
		if e != nil {
			continue
		}
		var manifest protocol.PluginManifest
		if json.Unmarshal(raw, &manifest) != nil || len(validatePluginManifest(manifest)) > 0 {
			continue
		}
		current, exists := s.state.Plugins[manifest.ID]
		// Installed signed overrides retain their own lifecycle and version.
		if exists && current.Signature != "" {
			continue
		}
		current.ID, current.Name, current.Version, current.APIVersion = manifest.ID, manifest.Name, manifest.Version, manifest.APIVersion
		current.Manifest, current.Permissions, current.Health = manifest, manifest.Permissions, "healthy"
		if !exists {
			current.Status = "enabled"
		}
		s.state.Plugins[manifest.ID] = current
	}
}

func validPluginAssetPath(name string) bool {
	return fs.ValidPath(name) && !strings.Contains(name, "\\") && !strings.Contains(name, ":")
}
func readPluginAsset(id, name, signature string) ([]byte, error) {
	if !validPluginAssetPath(name) {
		return nil, fmt.Errorf("invalid plugin path")
	}
	if bundledAssets != nil && signature == "" && !(os.Getenv("LINKOS_PLUGIN_DIR") != "" && !pluginSignaturesRequired()) {
		return fs.ReadFile(bundledAssets, path.Join("bundle/plugins", pluginDirName(id), name))
	}
	target, err := safeArtifactPath(filepath.Join(pluginRoot(), pluginDirName(id)), name)
	if err != nil {
		return nil, err
	}
	// Check only the configured tree; resolving every ancestor can require
	// permissions outside a sandbox even when the actual asset is readable.
	root := filepath.Join(pluginRoot(), pluginDirName(id))
	for _, part := range append([]string{""}, strings.Split(name, "/")...) {
		root = filepath.Join(root, part)
		info, e := os.Lstat(root)
		if e != nil {
			return nil, e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("plugin asset symlinks are not allowed")
		}
	}
	return os.ReadFile(target)
}

func webHandler() http.Handler {
	var web fs.FS
	if root := os.Getenv("LINKOS_WEB_DIR"); root != "" {
		web = os.DirFS(root)
	} else if bundledAssets != nil {
		web, _ = fs.Sub(bundledAssets, "bundle/web")
	}
	if web == nil {
		return http.NotFoundHandler()
	}
	files := http.FileServer(http.FS(web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(405)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/__linkos/") {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		info, err := fs.Stat(web, name)
		if err != nil || info.IsDir() {
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			clone := r.Clone(r.Context())
			clonedURL := *r.URL
			clonedURL.Path = "/"
			clone.URL = &clonedURL
			r = clone
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func checkAssets() error {
	if root := os.Getenv("LINKOS_WEB_DIR"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
			return err
		}
	}
	if bundledAssets != nil {
		if _, err := fs.Stat(bundledAssets, "bundle/web/index.html"); err != nil {
			return err
		}
		dirs, err := fs.ReadDir(bundledAssets, "bundle/plugins")
		if err != nil {
			return err
		}
		for _, dir := range dirs {
			raw, e := fs.ReadFile(bundledAssets, path.Join("bundle/plugins", dir.Name(), "manifest.json"))
			if e != nil {
				return e
			}
			var manifest protocol.PluginManifest
			if e = json.Unmarshal(raw, &manifest); e != nil {
				return e
			}
			for _, entry := range manifest.Entry {
				if !fs.ValidPath(entry) {
					return fmt.Errorf("invalid bundled entry")
				}
				if _, e = fs.Stat(bundledAssets, path.Join("bundle/plugins", dir.Name(), entry)); e != nil {
					return e
				}
			}
		}
	} else if root := os.Getenv("LINKOS_WEB_DIR"); root != "" {
		_, err := os.Stat(filepath.Join(root, "index.html"))
		return err
	}
	return nil
}
