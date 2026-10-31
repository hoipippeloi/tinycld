package reports

import (
	"testing"
)

const sitesWithAnimals = `{"version":1,"source":"zoo.sites","columns":[
	{"id":"site","path":[{"field":"name"}]},
	{"id":"animal","path":[{"link":"animals","mode":"nest"},{"field":"name"}]},
	{"id":"owner","path":[{"link":"animals","mode":"nest"},{"link":"owner"},{"field":"name"}]},
	{"id":"fed","path":[{"link":"animals","mode":"nest"},{"link":"feedings","mode":"nest"},{"field":"fed"}]}],
	"sort":[{"col":"site"}]}`

func TestNestedChildRowsHangUnderTheirParent(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sitesWithAnimals, Options{}, nil)
	requireRows(t, res, "label", "North", "Leo", "2026-01-05", "2026-02-10", "South", "Zed", "2026-01-20", "2026-03-03", "Total")
	requireRows(t, res, "owner", nil, "ann", nil, nil, nil, "bob", nil, nil, nil)
	north, leo := res.Rows[0], res.Rows[1]
	if leo.Parent != north.ID || leo.Depth != 1 || leo.ID != north.ID+"/"+z.id("leo") {
		t.Fatalf("leo = %+v", leo)
	}
	if fed := res.Rows[2]; fed.Parent != leo.ID || fed.Depth != 2 {
		t.Fatalf("feeding = %+v", fed)
	}
	// Parent rows have no value for a child row column.
	if _, ok := north.Cells["animal"]; !ok || north.Cells["animal"] != nil {
		t.Fatalf("north cells = %v", north.Cells)
	}
}

func TestNestedRowsTheReaderCannotSeeAreLeftOut(t *testing.T) {
	z := newZoo(t)
	// Bob may list mo and zed; in the north he sees mo, not leo.
	res := z.run(t, "bob", sitesWithAnimals, Options{}, nil)
	requireRows(t, res, "label", "North", "Mo", "2026-02-14", "South", "Zed", "2026-01-20", "2026-03-03", "Total")
}

func TestNestedRowsStopAtTheRowCap(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 1 })
	res := z.run(t, "ann", sitesWithAnimals, Options{}, nil)
	codes := map[string]bool{}
	for _, n := range res.Notices {
		codes[n.Code] = true
	}
	if !codes["nestCap"] {
		t.Fatalf("notices = %+v", res.Notices)
	}
}
