package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// Applied only to verified HTML responses, never to the signed package on disk.
// Do not stop propagation: the plugin SDK must still receive the same gesture.
const pluginContextMenuGuard = `<script data-linkos-context-menu-guard>document.addEventListener("contextmenu",function(e){e.preventDefault()},true);document.addEventListener("keydown",function(e){if(!e.isComposing&&(e.key==="ContextMenu"||(e.shiftKey&&e.key==="F10")))e.preventDefault()},true);</script>`

func injectPluginContextMenuGuard(data []byte) []byte {
	bom := 0
	var order binary.ByteOrder
	switch {
	case bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}):
		bom = 3
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		bom, order = 2, binary.LittleEndian
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		bom, order = 2, binary.BigEndian
	}
	view := data[bom:]
	guard := []byte(pluginContextMenuGuard)
	if order != nil {
		// Decode only a parsing view. Never re-encode the original document:
		// even malformed UTF-16 and an odd trailing byte must survive intact.
		units := make([]uint16, (len(view)+1)/2)
		for i := range units {
			if i*2+1 < len(view) {
				units[i] = order.Uint16(view[i*2:])
			} else {
				units[i] = utf8.RuneError
			}
		}
		view = []byte(string(utf16.Decode(units)))
		guard = make([]byte, len(pluginContextMenuGuard)*2)
		// The guard is ASCII; encode each byte as one UTF-16 code unit.
		for i := range pluginContextMenuGuard {
			order.PutUint16(guard[i*2:], uint16(pluginContextMenuGuard[i]))
		}
	}
	viewPosition := pluginContextMenuGuardPosition(view)
	position := bom + viewPosition
	if order != nil {
		position = bom
		for _, r := range string(view[:viewPosition]) {
			width := 2
			if r > 0xffff {
				width = 4
			}
			// An EOF replacement rune may represent just one trailing byte.
			position += min(width, len(data)-position)
		}
	}
	result := make([]byte, 0, len(data)+len(guard))
	result = append(result, data[:position]...)
	result = append(result, guard...)
	return append(result, data[position:]...)
}

// Return an offset into the readable view, not a serialized HTML document.
func pluginContextMenuGuardPosition(view []byte) int {
	position := 0
	tokens := html.NewTokenizer(bytes.NewReader(view))
scan:
	for {
		kind := tokens.Next()
		raw := tokens.Raw()
		switch kind {
		case html.CommentToken:
			if bytes.HasPrefix(raw, []byte("<!--")) {
				// A CommentToken can also end at EOF. Only these endings
				// close a real comment; a lone '>' in its body does not.
				body := raw[len("<!--"):]
				if !bytes.Equal(body, []byte(">")) && !bytes.Equal(body, []byte("->")) &&
					!bytes.HasSuffix(body, []byte("-->")) && !bytes.HasSuffix(body, []byte("--!>")) {
					break scan
				}
			}
			fallthrough
		case html.DoctypeToken:
			// Bogus comments and declarations terminate at '>', not EOF.
			if !bytes.HasSuffix(raw, []byte(">")) {
				break scan
			}
		case html.TextToken:
			if len(bytes.Trim(raw, " \t\n\r\f")) != 0 {
				break scan
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			token := tokens.Token()
			if token.Data != "html" && token.Data != "head" && token.Data != "meta" {
				break scan
			}
			// Structural on* attributes do not execute while parsing the tag.
			// Inserting before it would make the parser synthesize a head and
			// then discard the document's real head and its attributes.
			if token.Data == "html" || token.Data == "head" {
				break
			}
			charset := false
			for _, attr := range token.Attr {
				if strings.HasPrefix(attr.Key, "on") {
					break scan
				}
				if attr.Key == "charset" || (attr.Key == "http-equiv" && strings.EqualFold(attr.Val, "content-type")) {
					charset = true
				}
			}
			if token.Data == "meta" && !charset {
				break scan
			}
		default:
			break scan
		}
		position += len(raw)
	}
	return position
}
