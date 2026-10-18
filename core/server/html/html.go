// Package html converts between ProseMirror JSON and HTML.
//
// It exists for richtext fields whose live form is a Yjs fragment: a host's room
// flushes the fragment into a plain column, and the stored form has to be
// something search, exports and non-editor readers can consume without a
// ProseMirror runtime. ToPM seeds a fragment from stored HTML, FromPM
// serializes it back.
//
// The contract is FromPM(ToPM(x)) == x for HTML that FromPM wrote. FromPM's
// output is byte-stable (marks nest in a fixed order) because the flush path
// compares serialized output with the stored value to decide whether a row
// changed; unstable output would rewrite every row on every flush. Arbitrary
// HTML is not preserved: constructs the editor schema cannot hold degrade to
// paragraphs or are dropped.
//
// Link hrefs and image srcs are carried verbatim and are not scheme-checked; a
// consumer that renders the output must sanitize it (see
// `server/render/sanitize.go`).
//
// The node and mark vocabulary is the one in package markdown, which in turn
// mirrors the shared editor's schema.
package html

import "tinycld.org/core/markdown"

// markOrder is the fixed outermost-to-innermost nesting order for marks.
var markOrder = []string{
	markdown.MarkLink,
	markdown.MarkBold,
	markdown.MarkItalic,
	markdown.MarkUnderline,
	markdown.MarkStrike,
	markdown.MarkCode,
}

func attrString(attrs map[string]any, key string) string {
	v, _ := attrs[key].(string)
	return v
}

func attrBool(attrs map[string]any, key string) bool {
	v, _ := attrs[key].(bool)
	return v
}

// attrInt accepts both float64 (decoded JSON) and int (built in Go).
func attrInt(attrs map[string]any, key string) (int, bool) {
	switch v := attrs[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}
