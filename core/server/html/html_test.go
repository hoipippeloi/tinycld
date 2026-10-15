package html

import (
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
