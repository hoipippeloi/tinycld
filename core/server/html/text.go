package html

import (
	"strings"

	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// PlainText returns the text of an HTML fragment for indexing: text nodes
// only, with script, style, template and noscript subtrees skipped, entities
// decoded, and blocks separated by one space.
func PlainText(s string) string {
	nodes, err := nethtml.ParseFragment(strings.NewReader(s), &nethtml.Node{Type: nethtml.ElementNode, DataAtom: atom.Body, Data: "body"})
	if err != nil {
		return strings.TrimSpace(s)
	}
	var b strings.Builder
	var walk func(n *nethtml.Node)
	walk = func(n *nethtml.Node) {
		switch n.Type {
		case nethtml.TextNode:
			b.WriteString(n.Data)
		case nethtml.ElementNode:
			switch n.DataAtom {
			case atom.Script, atom.Style, atom.Template, atom.Noscript:
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == nethtml.ElementNode {
			b.WriteByte(' ')
		}
	}
	for _, n := range nodes {
		walk(n)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}
