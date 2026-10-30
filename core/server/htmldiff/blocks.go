package htmldiff

import (
	"strings"

	"golang.org/x/net/html"
)

// output collects rendered blocks; consecutive list items share one list
// element, so an added item stays inside its <ul>/<ol>.
type output struct {
	items []outItem
}

type outItem struct {
	list  *html.Node // non-nil: a list whose items are in parts
	parts []string
}

func (o *output) add(op blockOp) {
	b := op.to
	if b == nil {
		b = op.from
	}
	markup := renderOp(op)
	if b.parent == nil {
		o.items = append(o.items, outItem{parts: []string{markup}})
		return
	}
	if n := len(o.items); n > 0 && o.items[n-1].list != nil && o.items[n-1].list.Data == b.parent.Data {
		o.items[n-1].parts = append(o.items[n-1].parts, markup)
		return
	}
	o.items = append(o.items, outItem{list: b.parent, parts: []string{markup}})
}

func (o *output) render(wrapper *html.Node) (string, error) {
	var body strings.Builder
	for _, it := range o.items {
		inner := strings.Join(it.parts, "")
		if it.list == nil {
			body.WriteString(inner)
			continue
		}
		body.WriteString(withContent(it.list, inner))
	}
	if wrapper == nil {
		return body.String(), nil
	}
	return withContent(wrapper, body.String()), nil
}

func renderOp(op blockOp) string {
	switch op.kind {
	case opInsert:
		return withAttr(op.to.node, "data-diff", "ins")
	case opDelete:
		return withAttr(op.from.node, "data-diff", "del")
	case opChanged:
		return withContent(op.to.node, wordDiff(op.from.key, op.to.key))
	default:
		if op.from.markup == op.to.markup {
			return op.to.markup
		}
		return withAttr(op.to.node, "data-changed", "format")
	}
}

// withAttr renders n with one more attribute and its own children.
func withAttr(n *html.Node, key, value string) string {
	c := detached(n)
	c.Attr = append(append([]html.Attribute(nil), n.Attr...), html.Attribute{Key: key, Val: value})
	return render(c)
}

// withContent renders n's start and end tags around raw, already-rendered
// HTML.
func withContent(n *html.Node, raw string) string {
	c := detached(n)
	content := &html.Node{Type: html.RawNode, Data: raw}
	c.FirstChild, c.LastChild = content, content
	return render(c)
}

// detached copies n without links to its siblings or parent, sharing its
// children, so it renders on its own.
func detached(n *html.Node) *html.Node {
	c := *n
	c.Parent, c.PrevSibling, c.NextSibling = nil, nil, nil
	return &c
}

func splitWords(s string) []string {
	return strings.Fields(s)
}

// wordDiff marks changed words. Inline markup in a changed block is not
// kept: the block shows as text with marks.
func wordDiff(from, to string) string {
	a, b := splitWords(from), splitWords(to)
	pairs := lcsPairs(a, b)
	var tokens []string
	i, j := 0, 0
	flush := func(tag string, words []string) {
		if len(words) > 0 {
			tokens = append(tokens, "<"+tag+">"+escapeWords(words)+"</"+tag+">")
		}
	}
	for _, p := range append(pairs, [2]int{len(a), len(b)}) {
		flush("del", a[i:p[0]])
		flush("ins", b[j:p[1]])
		if p[0] < len(a) && p[1] < len(b) {
			tokens = append(tokens, html.EscapeString(b[p[1]]))
		}
		i, j = p[0]+1, p[1]+1
	}
	return strings.Join(tokens, " ")
}

func escapeWords(words []string) string {
	escaped := make([]string, len(words))
	for i, w := range words {
		escaped[i] = html.EscapeString(w)
	}
	return strings.Join(escaped, " ")
}

func renderTooLarge(wrapper *html.Node, blocks []block) (string, error) {
	var body strings.Builder
	body.WriteString(`<p data-changed="too-large">This document is too large to compare. It is shown without changes marked.</p>`)
	for _, b := range blocks {
		body.WriteString(b.markup)
	}
	if wrapper == nil {
		return body.String(), nil
	}
	return withContent(wrapper, body.String()), nil
}
