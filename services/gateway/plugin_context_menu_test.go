package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"golang.org/x/net/html"
)

func requirePluginGuardBytes(t *testing.T, source, result, prefix, guard []byte) {
	t.Helper()
	if bytes.Count(result, guard) != 1 {
		t.Fatal("response must contain exactly one injected guard")
	}
	position := bytes.Index(result, guard)
	if !bytes.Equal(result[:position], prefix) {
		t.Fatalf("guard prefix = %q, want %q", result[:position], prefix)
	}
	restored := append(append([]byte(nil), result[:position]...), result[position+len(guard):]...)
	if !bytes.Equal(restored, source) {
		t.Fatal("removing only the guard must restore every original byte")
	}
}

func TestPluginContextMenuGuardCommentTermination(t *testing.T) {
	const prefix = "<!doctype html><html><head>"
	cases := []struct {
		name    string
		comment string
		closed  bool
	}{
		{"EOF after greater-than", "<!-- unfinished >", false},
		{"EOF after bang greater-than", "<!--!>", false},
		{"EOF in comment", "<!-- unfinished", false},
		{"EOF after dashes", "<!-- unfinished --", false},
		{"EOF after bang", "<!-- unfinished --!", false},
		{"closed at EOF", "<!-- complete -->", true},
		{"bang close at EOF", "<!-- complete --!>", true},
		{"abrupt empty close", "<!-->", true},
		{"abrupt dash close", "<!--->", true},
		{"bogus declaration", "<!bogus>", true},
		{"processing instruction", "<?bogus>", true},
		{"bogus EOF", "<!bogus", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := []byte(prefix + tc.comment)
			wantPrefix := prefix
			if tc.closed {
				wantPrefix += tc.comment
			}
			result := injectPluginContextMenuGuard(source)
			requirePluginGuardBytes(t, source, result, []byte(wantPrefix), []byte(pluginContextMenuGuard))
			tokens := html.NewTokenizer(bytes.NewReader(result))
			guards := 0
			for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
				if kind == html.StartTagToken && tokens.Token().Data == "script" {
					guards++
				}
			}
			if guards != 1 {
				t.Fatalf("guard must parse as a script, not comment text: got %d scripts", guards)
			}
		})
	}
}

func TestPluginContextMenuGuardStructuralAttributes(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
	}{
		{"html handler", `<!doctype html><html onload="run()"><head id="original-head">`},
		{"head handler", `<!doctype html><html><head id="original-head" onclick="run()">`},
		{"both handlers and charset", `<!doctype html><HTML ONLOAD="run()"><HEAD ID="original-head" onClick="run()"><META CHARSET="utf-8">`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := []byte(tc.prefix + `<script>run()</script></head><body>插件</body></html>`)
			result := injectPluginContextMenuGuard(source)
			requirePluginGuardBytes(t, source, result, []byte(tc.prefix), []byte(pluginContextMenuGuard))
			document, err := html.Parse(bytes.NewReader(result))
			if err != nil {
				t.Fatal(err)
			}
			var scripts []*html.Node
			var visit func(*html.Node)
			visit = func(node *html.Node) {
				if node.Type == html.ElementNode && node.Data == "script" {
					scripts = append(scripts, node)
				}
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					visit(child)
				}
			}
			visit(document)
			if len(scripts) != 2 || scripts[0].Parent != scripts[1].Parent || scripts[0].Parent.Data != "head" {
				t.Fatal("guard and plugin script must remain in the original head")
			}
			originalHead := false
			for _, attr := range scripts[0].Parent.Attr {
				if attr.Key == "id" && attr.Val == "original-head" {
					originalHead = true
				}
			}
			if !originalHead || scripts[0].FirstChild == nil || !strings.Contains(scripts[0].FirstChild.Data, "contextmenu") {
				t.Fatal("guard must run first without replacing the original head")
			}
		})
	}
}

func pluginGuardUTF16Bytes(text string, order binary.ByteOrder) []byte {
	units := utf16.Encode([]rune(text))
	data := make([]byte, len(units)*2)
	for i, unit := range units {
		order.PutUint16(data[i*2:], unit)
	}
	return data
}

func TestPluginContextMenuGuardUTF16(t *testing.T) {
	for _, order := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		t.Run(order.String(), func(t *testing.T) {
			encode := func(text string) []byte { return pluginGuardUTF16Bytes(text, order) }
			malformed := encode("<!-- ")
			for _, unit := range []uint16{0xd800, ' ', 0xdc00} {
				var raw [2]byte
				order.PutUint16(raw[:], unit)
				malformed = append(malformed, raw[:]...)
			}
			malformed = append(malformed, encode(" --><html><head>")...)
			cases := []struct {
				name   string
				prefix []byte
				suffix []byte
			}{
				{"document", encode(" \r\n<!-- 插件 \U0001d11e --><!doctype html><html onload='run()'><head id='原始\U0001d11e' onclick='run()'><meta charset='utf-16'>"), encode("<script>run()</script></head><body>原文\U0001d11e</body></html>")},
				{"unfinished comment", encode("<html><head>"), encode("<!-- unfinished >")},
				{"fragment", nil, encode("<p>插件\U0001d11e</p>")},
				{"BOM only", nil, nil},
				{"unpaired surrogates and odd tail", malformed, append(encode("<script>run()</script>"), 0xff)},
				{"odd byte only", nil, []byte{0xff}},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					prefix := append(encode("\ufeff"), tc.prefix...)
					source := append(append([]byte(nil), prefix...), tc.suffix...)
					original := bytes.Clone(source)
					result := injectPluginContextMenuGuard(source)
					if !bytes.HasPrefix(result, encode("\ufeff")) {
						t.Fatal("UTF-16 BOM must remain the first two response bytes")
					}
					requirePluginGuardBytes(t, original, result, prefix, encode(pluginContextMenuGuard))
					if !bytes.Equal(source, original) {
						t.Fatal("injection must not mutate its source buffer")
					}
				})
			}
		})
	}
}

func TestPluginViewsInstallContextMenuGuard(t *testing.T) {
	cases := []struct {
		name   string
		source string
		prefix string
		order  binary.ByteOrder
	}{
		{"document", "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><script>window.loaded=true</script></head><body>插件</body></html>", "<!DOCTYPE html><html><head><meta charset=\"utf-8\">", nil},
		{"omitted head", "<!doctype html><html><body onload=\"run()\">插件</body></html>", "<!doctype html><html>", nil},
		{"comments and BOM", "\xef\xbb\xbf<!-- <head><script>fake</script> --><!DOCTYPE HTML><HTML><HEAD><META CHARSET=utf-8><SCRIPT>run()</SCRIPT></HEAD></HTML>", "\xef\xbb\xbf<!-- <head><script>fake</script> --><!DOCTYPE HTML><HTML><HEAD><META CHARSET=utf-8>", nil},
		{"fragment", "<p onclick=\"run()\">插件</p>", "", nil},
		{"plain text", "插件内容", "", nil},
		{"empty", "", "", nil},
		{"unfinished comment", "<!doctype html><html><head><!-- unfinished >", "<!doctype html><html><head>", nil},
		{"structural handlers", "<!doctype html><html onload='run()'><head id='original' onclick='run()'><script>run()</script></head></html>", "<!doctype html><html onload='run()'><head id='original' onclick='run()'>", nil},
		{"UTF16LE", "\ufeff<!doctype html><html><head id='原文\U0001d11e'><script>run()</script></head></html>", "\ufeff<!doctype html><html><head id='原文\U0001d11e'>", binary.LittleEndian},
		{"UTF16BE", "\ufeff<!doctype html><html><head id='原文\U0001d11e'><script>run()</script></head></html>", "\ufeff<!doctype html><html><head id='原文\U0001d11e'>", binary.BigEndian},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encode := func(text string) []byte {
				if tc.order != nil {
					return pluginGuardUTF16Bytes(text, tc.order)
				}
				return []byte(text)
			}
			source := encode(tc.source)
			store, _, handler, token := pluginFixture(t, memoryBackend{})
			manifest := fixtureManifest("fixture.guard", "1.0.0")
			inspect := pluginCall(handler, token, "POST", "/api/v1/plugin-packages/inspect", fixturePackage(t, manifest, string(source), nil, nil))
			requirePluginCode(t, inspect, 200, "")
			var stage stagedPlugin
			json.Unmarshal(inspect.Body.Bytes(), &stage)
			ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{"stageId": stage.ID})
			requirePluginCode(t, ticket, 200, "")
			var view struct{ Nonce, Src string }
			json.Unmarshal(ticket.Body.Bytes(), &view)
			response := pluginCall(handler, "", "GET", view.Src, nil)
			requirePluginCode(t, response, 200, "")
			requirePluginGuardBytes(t, source, response.Body.Bytes(), encode(tc.prefix), encode(pluginContextMenuGuard))
			if !strings.Contains(pluginContextMenuGuard, "contextmenu") || !strings.Contains(pluginContextMenuGuard, "preventDefault") || !strings.Contains(pluginContextMenuGuard, "F10") || strings.Contains(pluginContextMenuGuard, "stopPropagation") {
				t.Fatal("guard must cancel menus without preventing SDK event delivery")
			}
			head := pluginCall(handler, "", "HEAD", view.Src, nil)
			requirePluginCode(t, head, 200, "")
			if head.Body.Len() != 0 {
				t.Fatal("HEAD must not return the injected document")
			}
			csp := response.Header().Get("Content-Security-Policy")
			for _, rule := range []string{"connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"} {
				if !strings.Contains(csp, rule) {
					t.Fatalf("sandbox policy lost %q", rule)
				}
			}
			installed := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/install", map[string]interface{}{"stageId": stage.ID, "expectedRevision": stage.ExpectedRevision, "probeNonce": view.Nonce})
			requirePluginCode(t, installed, 200, "")
			store.mu.RLock()
			record := store.state.Plugins[manifest.ID]
			store.mu.RUnlock()
			if _, err := store.transitionPlugin(record.ID, "enable", record.Revision); err != nil {
				t.Fatal(err)
			}
			// A fresh ticket without stageId exercises installed-package reads.
			ticket = pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{})
			requirePluginCode(t, ticket, 200, "")
			if err := json.Unmarshal(ticket.Body.Bytes(), &view); err != nil {
				t.Fatal(err)
			}
			response = pluginCall(handler, "", "GET", view.Src, nil)
			requirePluginCode(t, response, 200, "")
			requirePluginGuardBytes(t, source, response.Body.Bytes(), encode(tc.prefix), encode(pluginContextMenuGuard))
			head = pluginCall(handler, "", "HEAD", view.Src, nil)
			requirePluginCode(t, head, 200, "")
			if head.Body.Len() != 0 {
				t.Fatal("installed HEAD must not return the injected document")
			}
			if err := store.verifyPluginResources(record); err != nil {
				t.Fatalf("guard must not mutate stored package or digest: %v", err)
			}
			stored, err := store.readManagedPluginAsset(record, "ui/index.html")
			if err != nil || !bytes.Equal(stored, source) {
				t.Fatalf("stored HTML must remain byte-for-byte original: %v", err)
			}
		})
	}
}

func TestPluginViewsContextMenuGuardLeavesNonHTMLUnchanged(t *testing.T) {
	manifest := fixtureManifest("fixture.guard.assets", "1.0.0")
	const source = "<!doctype html><html><head></head></html>"
	assets := map[string]string{
		"ui/script.js": `const template = "<html><head></head></html>";`,
		"ui/style.css": "/* <head> */ body { color: red; }",
		"ui/icon.svg":  `<svg xmlns="http://www.w3.org/2000/svg"><text>插件</text></svg>`,
		"ui/data.bin":  "\xff\xfe\x00\x80<head>\x00\xff",
	}
	// Reuse the ZIP fixture, supplying a checksum list that also covers assets.
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"manifest.json": string(rawManifest), "ui/index.html": source}
	extra := make(map[string]string)
	for name, data := range assets {
		files[name], extra[name] = data, data
	}
	checks := pluginChecksums{Format: 1}
	for name, data := range files {
		sum := sha256.Sum256([]byte(data))
		checks.Files = append(checks.Files, pluginFileHash{Path: name, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])})
	}
	rawChecks, err := json.Marshal(checks)
	if err != nil {
		t.Fatal(err)
	}
	extra["checksums.json"] = string(rawChecks)
	pkg := fixturePackage(t, manifest, source, nil, extra)
	for _, installed := range []bool{false, true} {
		name := "staged"
		if installed {
			name = "installed"
		}
		t.Run(name, func(t *testing.T) {
			store, _, handler, token := pluginFixture(t, memoryBackend{})
			inspect := pluginCall(handler, token, "POST", "/api/v1/plugin-packages/inspect", pkg)
			requirePluginCode(t, inspect, 200, "")
			var stage stagedPlugin
			if err := json.Unmarshal(inspect.Body.Bytes(), &stage); err != nil {
				t.Fatal(err)
			}
			ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{"stageId": stage.ID})
			requirePluginCode(t, ticket, 200, "")
			var view struct{ Nonce, Src string }
			if err := json.Unmarshal(ticket.Body.Bytes(), &view); err != nil {
				t.Fatal(err)
			}
			if installed {
				requirePluginCode(t, pluginCall(handler, "", "GET", view.Src, nil), 200, "")
				result := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/install", map[string]interface{}{"stageId": stage.ID, "expectedRevision": stage.ExpectedRevision, "probeNonce": view.Nonce})
				requirePluginCode(t, result, 200, "")
				store.mu.RLock()
				record := store.state.Plugins[manifest.ID]
				store.mu.RUnlock()
				if _, err := store.transitionPlugin(record.ID, "enable", record.Revision); err != nil {
					t.Fatal(err)
				}
				ticket = pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{})
				requirePluginCode(t, ticket, 200, "")
				if err := json.Unmarshal(ticket.Body.Bytes(), &view); err != nil {
					t.Fatal(err)
				}
			}
			for asset, data := range assets {
				t.Run(asset, func(t *testing.T) {
					url := "/api/v1/plugin-views/" + view.Nonce + "/" + asset
					response := pluginCall(handler, "", "GET", url, nil)
					requirePluginCode(t, response, 200, "")
					if !bytes.Equal(response.Body.Bytes(), []byte(data)) {
						t.Fatal("non-HTML response must remain byte-for-byte original")
					}
					if strings.HasPrefix(response.Header().Get("Content-Type"), "text/html") {
						t.Fatal("non-HTML fixture must exercise a non-HTML content type")
					}
					head := pluginCall(handler, "", "HEAD", url, nil)
					requirePluginCode(t, head, 200, "")
					if head.Body.Len() != 0 {
						t.Fatal("non-HTML HEAD must not return a body")
					}
				})
			}
		})
	}
}

func TestPluginViewsContextMenuGuardRejectsTampering(t *testing.T) {
	for _, mode := range []string{"staged", "installed"} {
		for _, target := range []string{"ui/index.html", "checksums.json"} {
			t.Run(mode+"/"+target, func(t *testing.T) {
				store, _, handler, token := pluginFixture(t, memoryBackend{})
				manifest := fixtureManifest("fixture.guard.integrity", "1.0.0")
				const source = "<!doctype html><html><head></head><body>verified</body></html>"
				var directory, stageID string
				if mode == "installed" {
					record := installFixture(t, handler, token, manifest, source)
					if _, err := store.transitionPlugin(record.ID, "enable", record.Revision); err != nil {
						t.Fatal(err)
					}
					var err error
					directory, err = store.packageDirectory(record)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					inspect := pluginCall(handler, token, "POST", "/api/v1/plugin-packages/inspect", fixturePackage(t, manifest, source, nil, nil))
					requirePluginCode(t, inspect, 200, "")
					var stage stagedPlugin
					if err := json.Unmarshal(inspect.Body.Bytes(), &stage); err != nil {
						t.Fatal(err)
					}
					stageID = stage.ID
					store.pluginRuntime.mu.Lock()
					directory = store.pluginRuntime.stages[stageID].directory
					store.pluginRuntime.mu.Unlock()
				}
				ticket := pluginCall(handler, token, "POST", "/api/v1/plugins/"+manifest.ID+"/ticket", map[string]string{"stageId": stageID})
				requirePluginCode(t, ticket, 200, "")
				var view struct{ Src string }
				if err := json.Unmarshal(ticket.Body.Bytes(), &view); err != nil {
					t.Fatal(err)
				}
				response := pluginCall(handler, "", "GET", view.Src, nil)
				requirePluginCode(t, response, 200, "")
				requirePluginGuardBytes(t, []byte(source), response.Body.Bytes(), []byte("<!doctype html><html><head>"), []byte(pluginContextMenuGuard))
				// Corrupt only the temporary fixture, after a valid ticket exists.
				path := filepath.Join(directory, filepath.FromSlash(target))
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				data[len(data)-1] ^= 1 // Same size: rejection must validate the hash.
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
				for _, method := range []string{"GET", "HEAD"} {
					response = pluginCall(handler, "", method, view.Src, nil)
					requirePluginCode(t, response, 409, "PLUGIN_RESOURCE_INVALID")
					if strings.Contains(response.Body.String(), "data-linkos-context-menu-guard") || strings.Contains(response.Body.String(), "<html>") {
						t.Fatal("integrity failure must not serve or inject plugin HTML")
					}
				}
			})
		}
	}
}
