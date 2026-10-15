package html

import (
	"strings"

	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"tinycld.org/core/markdown"
)

// ToPM parses HTML into a ProseMirror document. Markup the editor schema has no
// node for degrades: unknown containers keep their text as paragraphs and
// unknown inline tags keep their text unstyled. An explicit <p></p> is kept
// (a blank line is editor state); only the paragraphs ToPM synthesizes itself,
// from loose inline content or an unknown container, are dropped when blank.
func ToPM(src string) *markdown.PMNode {
	doc := &markdown.PMNode{Type: markdown.NodeDoc}
	nodes, err := nethtml.ParseFragment(strings.NewReader(src), &nethtml.Node{
		Type:     nethtml.ElementNode,
		DataAtom: atom.Body,
		Data:     "body",
	})
	if err != nil {
		return doc
	}
	c := &blockCollector{}
	for _, n := range nodes {
		c.node(n)
	}
	doc.Content = c.finish()
	return doc
}

// blockCollector accumulates block nodes. Inline content seen at block level
// waits in pending until a block boundary, then becomes one paragraph.
type blockCollector struct {
	blocks  []markdown.PMNode
	pending []markdown.PMNode
}

func (c *blockCollector) finish() []markdown.PMNode {
	c.flush()
	return c.blocks
}

func (c *blockCollector) flush() {
	if !isBlank(c.pending) {
		c.blocks = append(c.blocks, markdown.PMNode{Type: markdown.NodeParagraph, Content: c.pending})
	}
	c.pending = nil
}

func (c *blockCollector) add(n markdown.PMNode) {
	c.flush()
	c.blocks = append(c.blocks, n)
}

func (c *blockCollector) children(n *nethtml.Node) {
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		c.node(ch)
	}
}

func (c *blockCollector) node(n *nethtml.Node) {
	if n.Type != nethtml.ElementNode {
		c.pending = appendInline(c.pending, n, nil)
		return
	}
	switch n.DataAtom {
	case atom.P:
		c.flush()
		c.addParagraph(inlineChildren(n))
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		c.add(markdown.PMNode{
			Type:    markdown.NodeHeading,
			Attrs:   map[string]any{"level": int(n.Data[1] - '0')},
			Content: inlineChildren(n),
		})
	case atom.Ul:
		c.add(listNode(n, false))
	case atom.Ol:
		c.add(listNode(n, true))
	case atom.Blockquote:
		c.add(markdown.PMNode{Type: markdown.NodeBlockquote, Content: blocksOf(n)})
	case atom.Pre:
		c.add(markdown.PMNode{Type: markdown.NodeCodeBlock, Content: textOnly(textContent(n))})
	case atom.Br, atom.Img, atom.Span, atom.A, atom.Strong, atom.B, atom.Em, atom.I,
		atom.U, atom.S, atom.Del, atom.Strike, atom.Code:
		c.pending = appendInline(c.pending, n, nil)
	default:
		// Unknown container (div, table cell, ...): its inline run closes at
		// both edges so each cell or division becomes its own paragraph.
		c.flush()
		c.children(n)
		c.flush()
	}
}

// addParagraph keeps an explicit <p> even when blank: the editor writes <p></p>
// for a blank line, and dropping it would break FromPM(ToPM(x)) == x. Only
// paragraphs ToPM synthesizes itself (see flush) are dropped when blank.
func (c *blockCollector) addParagraph(content []markdown.PMNode) {
	if isBlank(content) {
		content = nil
	}
	c.blocks = append(c.blocks, markdown.PMNode{Type: markdown.NodeParagraph, Content: content})
}

func blocksOf(n *nethtml.Node) []markdown.PMNode {
	c := &blockCollector{}
	c.children(n)
	return c.finish()
}

func listNode(n *nethtml.Node, ordered bool) markdown.PMNode {
	var items []markdown.PMNode
	tasks := false
	for li := n.FirstChild; li != nil; li = li.NextSibling {
		if li.DataAtom != atom.Li {
			continue
		}
		content := blocksOf(li)
		if len(content) == 0 {
			content = []markdown.PMNode{{Type: markdown.NodeParagraph}}
		}
		item := markdown.PMNode{Type: markdown.NodeListItem, Content: content}
		if checked, ok := attr(li, "data-checked"); ok {
			tasks = true
			item.Type = markdown.NodeTaskItem
			item.Attrs = map[string]any{"checked": checked == "true"}
		}
		items = append(items, item)
	}
	switch {
	case ordered:
		return markdown.PMNode{Type: markdown.NodeOrderedList, Content: items}
	case tasks:
		return markdown.PMNode{Type: markdown.NodeTaskList, Content: toTaskItems(items)}
	default:
		return markdown.PMNode{Type: markdown.NodeBulletList, Content: items}
	}
}

// toTaskItems makes a mixed list uniform: a taskList may only hold taskItems.
func toTaskItems(items []markdown.PMNode) []markdown.PMNode {
	for i := range items {
		if items[i].Type == markdown.NodeListItem {
			items[i].Type = markdown.NodeTaskItem
			items[i].Attrs = map[string]any{"checked": false}
		}
	}
	return items
}

func inlineChildren(n *nethtml.Node) []markdown.PMNode {
	var out []markdown.PMNode
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		out = appendInline(out, ch, nil)
	}
	return out
}

// appendInline flattens an inline subtree into text nodes, carrying the marks
// of every ancestor. Marks are collected in whatever order the HTML nests them;
// FromPM imposes the canonical order.
func appendInline(out []markdown.PMNode, n *nethtml.Node, marks []markdown.PMMark) []markdown.PMNode {
	switch n.Type {
	case nethtml.TextNode:
		if n.Data == "" {
			return out
		}
		return append(out, markdown.PMNode{Type: markdown.NodeText, Text: n.Data, Marks: copyMarks(marks)})
	case nethtml.ElementNode:
	default:
		return out
	}
	switch n.DataAtom {
	case atom.Br:
		return append(out, markdown.PMNode{Type: markdown.NodeHardBreak})
	case atom.Img:
		src, _ := attr(n, "src")
		alt, _ := attr(n, "alt")
		return append(out, markdown.PMNode{
			Type:  markdown.NodeImage,
			Attrs: map[string]any{"src": src, "alt": alt},
		})
	}
	if m, ok := markFor(n); ok {
		marks = append(copyMarks(marks), m)
	}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		out = appendInline(out, ch, marks)
	}
	return out
}

func markFor(n *nethtml.Node) (markdown.PMMark, bool) {
	switch n.DataAtom {
	case atom.Strong, atom.B:
		return markdown.PMMark{Type: markdown.MarkBold}, true
	case atom.Em, atom.I:
		return markdown.PMMark{Type: markdown.MarkItalic}, true
	case atom.U:
		return markdown.PMMark{Type: markdown.MarkUnderline}, true
	case atom.S, atom.Del, atom.Strike:
		return markdown.PMMark{Type: markdown.MarkStrike}, true
	case atom.Code:
		return markdown.PMMark{Type: markdown.MarkCode}, true
	case atom.A:
		href, ok := attr(n, "href")
		if !ok {
			return markdown.PMMark{}, false
		}
		return markdown.PMMark{Type: markdown.MarkLink, Attrs: map[string]any{"href": href}}, true
	}
	return markdown.PMMark{}, false
}

func copyMarks(marks []markdown.PMMark) []markdown.PMMark {
	if len(marks) == 0 {
		return nil
	}
	return append([]markdown.PMMark(nil), marks...)
}

func attr(n *nethtml.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func textContent(n *nethtml.Node) string {
	if n.Type == nethtml.TextNode {
		return n.Data
	}
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		b.WriteString(textContent(ch))
	}
	return b.String()
}

func textOnly(s string) []markdown.PMNode {
	if s == "" {
		return nil
	}
	return []markdown.PMNode{{Type: markdown.NodeText, Text: s}}
}

// isBlank reports whether the inline run has nothing worth a paragraph:
// no nodes, or only whitespace text (the gaps between block tags).
func isBlank(nodes []markdown.PMNode) bool {
	for _, n := range nodes {
		if n.Type != markdown.NodeText || strings.TrimSpace(n.Text) != "" {
			return false
		}
	}
	return true
}
