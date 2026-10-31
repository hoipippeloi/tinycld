package htmldiff

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

var betweenTags = regexp.MustCompile(`>\s*\n\s*<`)

func normalize(s string) string {
	return betweenTags.ReplaceAllString(strings.TrimSpace(s), "><")
}

func mustDiff(t *testing.T, from, to string) string {
	t.Helper()
	out, err := Diff(from, to)
	if err != nil {
		t.Fatal(err)
	}
	return normalize(out)
}

func TestDiff_Identical(t *testing.T) {
	got := mustDiff(t, "<p>a</p><p>b</p>", "<p>a</p><p>b</p>")
	if got != "<p>a</p><p>b</p>" {
		t.Fatalf("got %s", got)
	}
}

func TestDiff_InsertedParagraph(t *testing.T) {
	got := mustDiff(t, "<p>a</p><p>b</p>", "<p>a</p><p>new words here</p><p>b</p>")
	want := `<p>a</p><p data-diff="ins">new words here</p><p>b</p>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_DeletedParagraph(t *testing.T) {
	got := mustDiff(t, "<p>a</p><p>gone for good</p><p>b</p>", "<p>a</p><p>b</p>")
	want := `<p>a</p><p data-diff="del">gone for good</p><p>b</p>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_WordChange(t *testing.T) {
	got := mustDiff(t, "<p>the quick brown fox</p>", "<p>the slow brown fox</p>")
	want := `<p>the <del>quick</del> <ins>slow</ins> brown fox</p>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_FormatOnly(t *testing.T) {
	got := mustDiff(t, "<p>bold</p>", "<p><strong>bold</strong></p>")
	want := `<p data-changed="format"><strong>bold</strong></p>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_ListItems(t *testing.T) {
	got := mustDiff(t, "<ul><li>one</li><li>two</li></ul>", "<ul><li>one</li><li>added item</li><li>two</li></ul>")
	want := `<ul><li>one</li><li data-diff="ins">added item</li><li>two</li></ul>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_EmptyFromMarksAllInserted(t *testing.T) {
	got := mustDiff(t, "", "<p>first</p><p>second</p>")
	want := `<p data-diff="ins">first</p><p data-diff="ins">second</p>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_KeepsArticleWrapper(t *testing.T) {
	got := mustDiff(t, `<article class="tinycld-text"><p>a</p></article>`, `<article class="tinycld-text"><p>a</p><p>b</p></article>`)
	want := `<article class="tinycld-text"><p>a</p><p data-diff="ins">b</p></article>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_EscapesText(t *testing.T) {
	got := mustDiff(t, "<p>a &lt;b&gt; c</p>", "<p>a &lt;script&gt; c</p>")
	if strings.Contains(got, "<script>") {
		t.Fatalf("unescaped text in %s", got)
	}
}

// A block with structure (a table, an image, a line break, a link) cannot
// be shown as plain text with word marks; it is shown removed then added.
func TestDiff_ChangedTableKeepsItsStructure(t *testing.T) {
	got := mustDiff(t,
		"<table><tbody><tr><td>alpha beta gamma</td></tr></tbody></table>",
		"<table><tbody><tr><td>alpha beta delta</td></tr></tbody></table>")
	want := `<table data-diff="del"><tbody><tr><td>alpha beta gamma</td></tr></tbody></table>` +
		`<table data-diff="ins"><tbody><tr><td>alpha beta delta</td></tr></tbody></table>`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDiff_ChangedParagraphKeepsImageAndBreak(t *testing.T) {
	got := mustDiff(t,
		`<p>see the <img src="x.png"> picture<br>now</p>`,
		`<p>look at the <img src="x.png"> picture<br>now</p>`)
	if strings.Count(got, `<img src="x.png"/>`) != 2 || strings.Count(got, "<br/>") != 2 {
		t.Fatalf("images or breaks lost: %s", got)
	}
	if !strings.Contains(got, `data-diff="del"`) || !strings.Contains(got, `data-diff="ins"`) {
		t.Fatalf("got %s", got)
	}
}

func TestDiff_InlineFormattingStillGetsWordMarks(t *testing.T) {
	got := mustDiff(t, "<p>the <strong>quick</strong> fox</p>", "<p>the <strong>slow</strong> fox</p>")
	if !strings.Contains(got, "<del>quick</del>") || !strings.Contains(got, "<ins>slow</ins>") {
		t.Fatalf("got %s", got)
	}
}

func words(prefix string, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "%s%d ", prefix, i)
	}
	return b.String()
}

// Any reader can call compare. A long paragraph must not build a
// words×words table: above the limit the block is shown removed then added.
func TestDiff_HugeChangedBlockSkipsWordDiff(t *testing.T) {
	from := "<p>" + words("w", 4000) + "old</p>"
	to := "<p>" + words("w", 4000) + "new</p>"
	got := mustDiff(t, from, to)
	if strings.Contains(got, "<del>") || !strings.Contains(got, `data-diff="ins"`) {
		t.Fatalf("expected whole-block marks, got %d bytes", len(got))
	}
}

func TestDiff_TooManyBlocksShowsNoteInsteadOfDiffing(t *testing.T) {
	var from, to strings.Builder
	for i := 0; i < 2500; i++ {
		fmt.Fprintf(&from, "<p>from %d</p>", i)
		fmt.Fprintf(&to, "<p>to %d</p>", i)
	}
	got := mustDiff(t, from.String(), to.String())
	if !strings.Contains(got, `data-changed="too-large"`) {
		t.Fatalf("expected the too-large note")
	}
}
