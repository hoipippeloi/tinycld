package html

import (
	"strings"
	"testing"

	"tinycld.org/core/markdown"
)

func TestFromPM_RendersBlocksAndMarks(t *testing.T) {
	doc := &markdown.PMNode{Type: markdown.NodeDoc, Content: []markdown.PMNode{
		{Type: markdown.NodeHeading, Attrs: map[string]any{"level": 2}, Content: []markdown.PMNode{{Type: markdown.NodeText, Text: "Steps"}}},
		{Type: markdown.NodeParagraph, Content: []markdown.PMNode{
			{Type: markdown.NodeText, Text: "Open "},
			{Type: markdown.NodeText, Text: "settings", Marks: []markdown.PMMark{{Type: markdown.MarkBold}}},
			{Type: markdown.NodeText, Text: " & "},
			{Type: markdown.NodeText, Text: "docs", Marks: []markdown.PMMark{{Type: markdown.MarkLink, Attrs: map[string]any{"href": "https://x.test/?a=1&b=2"}}}},
		}},
		{Type: markdown.NodeBulletList, Content: []markdown.PMNode{
			{Type: markdown.NodeListItem, Content: []markdown.PMNode{{Type: markdown.NodeParagraph, Content: []markdown.PMNode{{Type: markdown.NodeText, Text: "one <two>"}}}}},
		}},
		{Type: markdown.NodeCodeBlock, Content: []markdown.PMNode{{Type: markdown.NodeText, Text: "a < b"}}},
	}}
	got := FromPM(doc)
	want := `<h2>Steps</h2><p>Open <strong>settings</strong> &amp; <a href="https://x.test/?a=1&amp;b=2">docs</a></p><ul><li><p>one &lt;two&gt;</p></li></ul><pre><code>a &lt; b</code></pre>`
	if got != want {
		t.Fatalf("FromPM:\n got %q\nwant %q", got, want)
	}
}

func TestToPM_ParsesWhatFromPMWrites(t *testing.T) {
	src := `<h2>Steps</h2><p>Open <strong>settings</strong> &amp; <a href="https://x.test/">docs</a><br>next</p><ul><li><p>one</p></li></ul><ol><li><p>first</p></li></ol><blockquote><p>q</p></blockquote><pre><code>a &lt; b</code></pre>`
	doc := ToPM(src)
	if got := FromPM(doc); got != src {
		t.Fatalf("round trip:\n got %q\nwant %q", got, src)
	}
}

func TestToPM_DegradesUnknownTags(t *testing.T) {
	doc := ToPM(`<div class="x"><span>plain</span> text</div><table><tr><td>cell</td></tr></table>`)
	if len(doc.Content) == 0 {
		t.Fatal("expected content")
	}
	if got := FromPM(doc); got != `<p>plain text</p><p>cell</p>` {
		t.Fatalf("got %q", got)
	}
}

func TestToPM_EmptyIsAnEmptyDoc(t *testing.T) {
	doc := ToPM("")
	if doc.Type != markdown.NodeDoc || len(doc.Content) != 0 {
		t.Fatalf("got %+v", doc)
	}
}

func TestRoundTrip_MarksTasksAndImages(t *testing.T) {
	src := `<p><a href="https://x.test/"><strong><em><u><s><code>all</code></s></u></em></strong></a></p>` +
		`<ul><li data-checked="true"><p>done</p></li><li data-checked="false"><p>todo</p></li></ul>` +
		`<p><img src="a.png" alt="A"></p>`
	if got := FromPM(ToPM(src)); got != src {
		t.Fatalf("round trip:\n got %q\nwant %q", got, src)
	}
}

func TestToPM_ReadsAnyMarkNestingOrder(t *testing.T) {
	doc := ToPM(`<p><code><s><u><em><strong><a href="https://x.test/">x</a></strong></em></u></s></code></p>`)
	want := `<p><a href="https://x.test/"><strong><em><u><s><code>x</code></s></u></em></strong></a></p>`
	if got := FromPM(doc); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRoundTrip_KeepsExplicitEmptyParagraph(t *testing.T) {
	src := `<p>a</p><p></p><p>b</p>`
	if got := FromPM(ToPM(src)); got != src {
		t.Fatalf("got %q want %q", got, src)
	}
}

func TestToPM_WhitespaceBetweenBlocksMakesNoParagraph(t *testing.T) {
	doc := ToPM("<p>a</p>\n<p>b</p>")
	if got := FromPM(doc); got != `<p>a</p><p>b</p>` {
		t.Fatalf("got %q", got)
	}
}

func TestToPM_EmptyDivYieldsNothing(t *testing.T) {
	if doc := ToPM("<div></div>"); len(doc.Content) != 0 {
		t.Fatalf("got %+v", doc.Content)
	}
}

func rt(t *testing.T, in string) string {
	t.Helper()
	return FromPM(ToPM(in))
}

func TestRoundTrip_CodeBlockLanguage(t *testing.T) {
	in := `<pre><code class="language-go">x := 1</code></pre>`
	if got := rt(t, in); got != in {
		t.Fatalf("got %q", got)
	}
	plain := `<pre><code>x</code></pre>`
	if got := rt(t, plain); got != plain {
		t.Fatalf("got %q", got)
	}
	doc := ToPM(in)
	if lang, _ := doc.Content[0].Attrs["language"].(string); lang != "go" {
		t.Fatalf("language = %v", doc.Content[0].Attrs)
	}
}

func TestRoundTrip_OrderedListStart(t *testing.T) {
	in := `<ol start="3"><li><p>x</p></li></ol>`
	if got := rt(t, in); got != in {
		t.Fatalf("got %q", got)
	}
	if got := rt(t, `<ol><li><p>x</p></li></ol>`); strings.Contains(got, "start=") {
		t.Fatalf("got %q", got)
	}
}

func TestToPM_EmptyBlockquoteHasAParagraph(t *testing.T) {
	doc := ToPM(`<blockquote></blockquote>`)
	if len(doc.Content) != 1 || len(doc.Content[0].Content) != 1 || doc.Content[0].Content[0].Type != markdown.NodeParagraph {
		t.Fatalf("got %+v", doc.Content)
	}
}

func TestToPM_OrderedListIgnoresDataChecked(t *testing.T) {
	doc := ToPM(`<ol><li data-checked="true"><p>a</p></li></ol>`)
	list := doc.Content[0]
	if list.Type != markdown.NodeOrderedList || list.Content[0].Type != markdown.NodeListItem {
		t.Fatalf("got %+v", list)
	}
}

func TestToPM_DuplicateMarksCollapse(t *testing.T) {
	if got := rt(t, `<p><strong><b>x</b></strong></p>`); got != `<p><strong>x</strong></p>` {
		t.Fatalf("got %q", got)
	}
}

func TestFromPM_DuplicateMarksWriteOnce(t *testing.T) {
	doc := &markdown.PMNode{Type: markdown.NodeDoc, Content: []markdown.PMNode{{Type: markdown.NodeParagraph, Content: []markdown.PMNode{
		{Type: markdown.NodeText, Text: "x", Marks: []markdown.PMMark{{Type: markdown.MarkBold}, {Type: markdown.MarkBold}}},
	}}}}
	if got := FromPM(doc); got != `<p><strong>x</strong></p>` {
		t.Fatalf("got %q", got)
	}
}

func TestRoundTrip_HrefIsVerbatim(t *testing.T) {
	in := `<p><a href="javascript:x">y</a></p>`
	if got := rt(t, in); got != in {
		t.Fatalf("got %q", got)
	}
}

func TestRoundTrip_NestedListsAndHardBreaks(t *testing.T) {
	for _, in := range []string{
		`<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>`,
		`<ul><li><p>a<br>b</p></li></ul>`,
	} {
		if got := rt(t, in); got != in {
			t.Fatalf("%q -> %q", in, got)
		}
	}
	doc := ToPM(`<ul><li>a<br>b</li></ul>`)
	para := doc.Content[0].Content[0].Content[0]
	if para.Type != markdown.NodeParagraph || len(para.Content) != 3 || para.Content[1].Type != markdown.NodeHardBreak {
		t.Fatalf("got %+v", para)
	}
}

func TestToPM_DecodesEntities(t *testing.T) {
	doc := ToPM(`<p>&lt;b&gt; &amp; &quot;q&quot; it&#39;s</p>`)
	if got := doc.Content[0].Content[0].Text; got != `<b> & "q" it's` {
		t.Fatalf("got %q", got)
	}
	if got := FromPM(doc); got != `<p>&lt;b&gt; &amp; &#34;q&#34; it&#39;s</p>` {
		t.Fatalf("got %q", got)
	}
}

func TestPlainText(t *testing.T) {
	got := PlainText("<p>a &amp; b</p><script>x()</script><ul><li>one</li><li>two</li></ul>")
	if want := "a & b one two"; got != want {
		t.Fatalf("PlainText = %q, want %q", got, want)
	}
}
