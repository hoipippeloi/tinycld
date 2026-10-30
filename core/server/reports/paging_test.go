package reports

import (
	"testing"
)

const feedingsPaged = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"note","path":[{"field":"note"}]},
	{"id":"fed","path":[{"field":"fed"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
	{"id":"running","formula":{"op":"runningSum","args":[{"col":"cost"}]}}],
	"sort":[{"col":"fed","dir":"desc"}]}`

func TestDetailRowsPageByKeyset(t *testing.T) {
	z := newZoo(t)
	// A feeding with no date sorts last, in either direction.
	z.rec(t, "f8", "zoo_feedings", map[string]any{"animal": z.id("leo"), "cost": 50, "currency": "USD", "note": "f8"})

	first := z.run(t, "ann", feedingsPaged, Options{Limit: 2}, nil)
	requireRows(t, first, "note", "f4", "f2", nil)
	if first.Page == nil || first.Page.Size != 2 || first.Page.Next == "" {
		t.Fatalf("page = %+v", first.Page)
	}
	// Every page ends in the total of every row, not of the page.
	requireRows(t, first, "cost", int64(300), int64(2500), int64(4550))

	second := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: first.Page.Next}, nil)
	requireRows(t, second, "note", "f3", "f1", nil)
	// A running sum runs over every row, across pages.
	requireRows(t, second, "running", int64(3500), int64(4500), int64(4550))

	third := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: second.Page.Next}, nil)
	requireRows(t, third, "note", "f8", nil)
	if third.Page.Next != "" {
		t.Fatalf("the last page has a next cursor: %+v", third.Page)
	}
}

func TestAPageStartsAfterItsCursorWhenRowsChange(t *testing.T) {
	z := newZoo(t)
	first := z.run(t, "ann", feedingsPaged, Options{Limit: 2}, nil)
	// A row added before the cursor's place does not shift the next page.
	z.feeding(t, "f9", z.recs["leo"], 10, "2026-03-31", 1)
	second := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: first.Page.Next}, nil)
	requireRows(t, second, "note", "f3", "f1", nil)
}

func TestACursorThisReportDidNotGiveIsRefused(t *testing.T) {
	z := newZoo(t)
	for _, cursor := range []string{"not base64!", "WyJ4Il0", "W3siYSI6MX0sImlkIl0"} {
		_, err := z.try(t, "ann", feedingsPaged, Options{Cursor: cursor}, nil)
		requireSpecError(t, err, 400, "options.cursor", "not one this report gave")
	}
}

func TestAPageHoldsAtMostTheLargestPage(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.maxPage = 3 })
	res := z.run(t, "ann", feedingsPaged, Options{Limit: 50}, nil)
	if res.Page.Size != 3 || res.Page.Next == "" {
		t.Fatalf("page = %+v", res.Page)
	}
}
