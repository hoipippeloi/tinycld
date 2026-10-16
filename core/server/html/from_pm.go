package html

import (
	stdhtml "html"
	"sort"
	"strconv"
	"strings"

	"tinycld.org/core/markdown"
)

// FromPM serializes a ProseMirror document to HTML.
func FromPM(doc *markdown.PMNode) string {
	if doc == nil {
		return ""
	}
	var b strings.Builder
	writeNode(&b, doc)
	return b.String()
}

func writeChildren(b *strings.Builder, n *markdown.PMNode) {
	for i := range n.Content {
		writeNode(b, &n.Content[i])
	}
}

func writeWrapped(b *strings.Builder, open string, n *markdown.PMNode, close string) {
	b.WriteString(open)
	writeChildren(b, n)
	b.WriteString(close)
}

func writeNode(b *strings.Builder, n *markdown.PMNode) {
	switch n.Type {
	case markdown.NodeParagraph:
		writeWrapped(b, "<p>", n, "</p>")
	case markdown.NodeHeading:
		tag := "h" + strconv.Itoa(headingLevel(n))
		writeWrapped(b, "<"+tag+">", n, "</"+tag+">")
	case markdown.NodeBulletList, markdown.NodeTaskList:
		writeWrapped(b, "<ul>", n, "</ul>")
	case markdown.NodeOrderedList:
		open := "<ol>"
		if start, ok := attrInt(n.Attrs, "start"); ok && start != 1 {
			open = `<ol start="` + strconv.Itoa(start) + `">`
		}
		writeWrapped(b, open, n, "</ol>")
	case markdown.NodeListItem:
		writeWrapped(b, "<li>", n, "</li>")
	case markdown.NodeTaskItem:
		writeWrapped(b, `<li data-checked="`+strconv.FormatBool(attrBool(n.Attrs, "checked"))+`">`, n, "</li>")
	case markdown.NodeBlockquote:
		writeWrapped(b, "<blockquote>", n, "</blockquote>")
	case markdown.NodeCodeBlock:
		open := "<pre><code>"
		if lang := attrString(n.Attrs, "language"); lang != "" {
			open = `<pre><code class="language-` + stdhtml.EscapeString(lang) + `">`
		}
		writeWrapped(b, open, n, "</code></pre>")
	case markdown.NodeHardBreak:
		b.WriteString("<br>")
	case markdown.NodeImage:
		writeImage(b, n)
	case markdown.NodeText:
		writeText(b, n)
	default:
		// An unknown node (doc included) is transparent so its content is kept.
		writeChildren(b, n)
	}
}

func headingLevel(n *markdown.PMNode) int {
	level, ok := attrInt(n.Attrs, "level")
	if !ok || level < 1 {
		return 1
	}
	return min(level, 6)
}

func writeImage(b *strings.Builder, n *markdown.PMNode) {
	b.WriteString(`<img src="` + stdhtml.EscapeString(attrString(n.Attrs, "src")) + `"`)
	if alt := attrString(n.Attrs, "alt"); alt != "" {
		b.WriteString(` alt="` + stdhtml.EscapeString(alt) + `"`)
	}
	b.WriteString(">")
}

func writeText(b *strings.Builder, n *markdown.PMNode) {
	if n.Text == "" {
		return
	}
	marks := sortedMarks(n.Marks)
	for _, m := range marks {
		b.WriteString(openMark(m))
	}
	b.WriteString(stdhtml.EscapeString(n.Text))
	for i := len(marks) - 1; i >= 0; i-- {
		b.WriteString(closeMark(marks[i]))
	}
}

func markRank(t string) int {
	for i, m := range markOrder {
		if m == t {
			return i
		}
	}
	return -1
}

// sortedMarks drops unknown and repeated marks (first wins) and orders the rest so equal content always
// serializes to equal bytes.
func sortedMarks(marks []markdown.PMMark) []markdown.PMMark {
	out := make([]markdown.PMMark, 0, len(marks))
	seen := map[string]bool{}
	for _, m := range marks {
		if markRank(m.Type) >= 0 && !seen[m.Type] {
			seen[m.Type] = true
			out = append(out, m)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return markRank(out[i].Type) < markRank(out[j].Type) })
	return out
}

func openMark(m markdown.PMMark) string {
	switch m.Type {
	case markdown.MarkLink:
		return `<a href="` + stdhtml.EscapeString(attrString(m.Attrs, "href")) + `">`
	case markdown.MarkBold:
		return "<strong>"
	case markdown.MarkItalic:
		return "<em>"
	case markdown.MarkUnderline:
		return "<u>"
	case markdown.MarkStrike:
		return "<s>"
	default:
		return "<code>"
	}
}

func closeMark(m markdown.PMMark) string {
	switch m.Type {
	case markdown.MarkLink:
		return "</a>"
	case markdown.MarkBold:
		return "</strong>"
	case markdown.MarkItalic:
		return "</em>"
	case markdown.MarkUnderline:
		return "</u>"
	case markdown.MarkStrike:
		return "</s>"
	default:
		return "</code>"
	}
}
