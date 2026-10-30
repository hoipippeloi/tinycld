package htmldiff

import (
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
