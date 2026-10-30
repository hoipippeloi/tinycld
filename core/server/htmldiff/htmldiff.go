// Package htmldiff marks the changes between two HTML fragments, for a
// version history compare view. It works on blocks (paragraphs, headings,
// list items, …) and, inside a changed block, on words.
//
// Output marks:
//   - data-diff="ins" / data-diff="del" on a block that was added or removed
//     (an attribute, not an <ins> wrapper, so lists and tables stay valid)
//   - <ins> / <del> around words that changed inside a block
//   - data-changed="format" on a block whose text is the same but whose
//     markup changed
package htmldiff

import (
	"bytes"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// maxLCSCells bounds every LCS table (blocks × blocks, words × words): any
// reader can ask for a compare, and the table is quadratic. Above it a
// document is shown with a note and no marks, and a changed block is shown
// removed then added instead of with word marks.
const maxLCSCells = 4_000_000

// similarEnough is the word-overlap ratio above which a removed block and
// an added block in the same place are shown as one block with word marks.
const similarEnough = 0.5

// Diff returns `to` with the changes from `from` marked. An empty `from`
// marks every block as inserted.
func Diff(fromHTML, toHTML string) (string, error) {
	fromWrap, fromBlocks, err := parse(fromHTML)
	if err != nil {
		return "", err
	}
	toWrap, toBlocks, err := parse(toHTML)
	if err != nil {
		return "", err
	}
	wrapper := toWrap
	if wrapper == nil {
		wrapper = fromWrap
	}
	if len(fromBlocks)*len(toBlocks) > maxLCSCells {
		return renderTooLarge(wrapper, toBlocks)
	}

	out := &output{}
	for _, op := range diffBlocks(fromBlocks, toBlocks) {
		out.add(op)
	}
	return out.render(wrapper)
}

type block struct {
	node   *html.Node
	parent *html.Node // the ul/ol around a list item; nil at the top level
	key    string     // normalized text, the match key
	markup string     // rendered HTML, to tell a format-only change
	// plain: only text and inline formatting inside, so word marks can
	// replace the content without losing a table, image, break or link.
	plain bool
}

// parse splits a fragment into blocks. A single <article> root is kept as
// the wrapper of the output.
func parse(s string) (*html.Node, []block, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil, nil
	}
	nodes, err := html.ParseFragment(strings.NewReader(s), &html.Node{
		Type: html.ElementNode, Data: "body", DataAtom: atom.Body,
	})
	if err != nil {
		return nil, nil, err
	}
	var wrapper *html.Node
	if root := onlyElement(nodes); root != nil && root.DataAtom == atom.Article {
		wrapper = root
		nodes = children(root)
	}
	var blocks []block
	for _, n := range nodes {
		switch {
		case n.Type == html.TextNode && strings.TrimSpace(n.Data) == "":
			continue
		case n.Type == html.ElementNode && (n.DataAtom == atom.Ul || n.DataAtom == atom.Ol):
			for _, c := range children(n) {
				if c.Type == html.ElementNode {
					blocks = append(blocks, newBlock(c, n))
				}
			}
		default:
			blocks = append(blocks, newBlock(n, nil))
		}
	}
	return wrapper, blocks, nil
}

func newBlock(n, parent *html.Node) block {
	markup := render(n)
	key := normalizeSpace(textOf(n))
	if key == "" {
		key = markup
	}
	return block{node: n, parent: parent, key: key, markup: markup, plain: isPlainText(n)}
}

// inlineFormatting are the elements a word-marked block may drop: they
// style text but hold no content of their own.
var inlineFormatting = map[atom.Atom]bool{
	atom.Span: true, atom.Strong: true, atom.B: true, atom.Em: true, atom.I: true,
	atom.U: true, atom.S: true, atom.Strike: true, atom.Sub: true, atom.Sup: true,
	atom.Code: true, atom.Mark: true, atom.Small: true,
}

func isPlainText(n *html.Node) bool {
	if n.Type != html.ElementNode || n.DataAtom == atom.Table {
		return false
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		switch {
		case c.Type == html.TextNode:
		case c.Type == html.ElementNode && inlineFormatting[c.DataAtom] && isPlainInline(c):
		default:
			return false
		}
	}
	return true
}

func isPlainInline(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			continue
		}
		if c.Type != html.ElementNode || !inlineFormatting[c.DataAtom] || !isPlainInline(c) {
			return false
		}
	}
	return true
}

func onlyElement(nodes []*html.Node) *html.Node {
	var found *html.Node
	for _, n := range nodes {
		if n.Type == html.TextNode && strings.TrimSpace(n.Data) == "" {
			continue
		}
		if n.Type != html.ElementNode || found != nil {
			return nil
		}
		found = n
	}
	return found
}

func children(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, c)
	}
	return out
}

func textOf(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(textOf(c))
		b.WriteByte(' ')
	}
	return b.String()
}

func normalizeSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func render(n *html.Node) string {
	var buf bytes.Buffer
	_ = html.Render(&buf, n)
	return buf.String()
}
