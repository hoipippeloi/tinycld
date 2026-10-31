package reports

import (
	"fmt"
	"reflect"
	"testing"
)

const costBySpeciesAndMonth = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
	"groups":[{"id":"g","col":"species"}],
	"pivot":{"path":[{"field":"fed"}],"bucket":"month","cell":"cost"%s}}`

func pivotIDs(res *Result) []string {
	var ids []string
	for _, c := range res.Columns {
		if c.Pivot != nil {
			ids = append(ids, c.ID+"="+c.Label)
		}
	}
	return ids
}

func TestPivotSplitsTheCellByValue(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", fmt.Sprintf(costBySpeciesAndMonth, ""), Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"cost.p0=2026-01", "cost.p1=2026-02", "cost.p2=2026-03"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	if c := res.Columns[2]; c.Pivot.Cell != "cost" || c.Pivot.Key != "2026-01" || c.Type != Money || c.CurrencyCell != "cost@currency" {
		t.Fatalf("pivot column = %+v", c)
	}
	requireRows(t, res, "label", "lion", "zebra", "Total")
	requireRows(t, res, "cost.p0", int64(1000), int64(700), int64(1700))
	requireRows(t, res, "cost.p1", int64(2500), int64(0), int64(2500))
	requireRows(t, res, "cost.p2", int64(0), int64(300), int64(300))
	// The cell column itself stays as the row's total across the pivot.
	requireRows(t, res, "cost", int64(3500), int64(1000), int64(4500))
	if res.Rows[0].Expanded {
		t.Fatal("a pivot's innermost group has no detail rows to open")
	}
}

func TestPivotStopsAtMaxColumnsAndSaysHowManyAreLeftOut(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", fmt.Sprintf(costBySpeciesAndMonth, `,"maxColumns":2`), Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"cost.p0=2026-01", "cost.p1=2026-02"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	if len(res.Notices) != 1 || res.Notices[0].Code != "pivotCap" || res.Notices[0].Count != 1 {
		t.Fatalf("notices = %+v", res.Notices)
	}
}

func TestTheRowCapNeverCutsPivotColumns(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 1 })
	res := z.run(t, "ann", fmt.Sprintf(costBySpeciesAndMonth, ""), Options{}, nil)
	if got := len(pivotIDs(res)); got != 3 {
		t.Fatalf("%d pivot columns, want 3", got)
	}
}

func TestPivotCellOfAnAverageAndAYearBucket(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "bob", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"grams","path":[{"field":"grams"}],"aggregate":"avg","scale":1}],
		"groups":[{"id":"g","col":"species"}],
		"pivot":{"path":[{"field":"fed"}],"bucket":"year","cell":"grams"}}`, Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"grams.p0=2026"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	requireRows(t, res, "label", "monkey", "zebra", "Total")
	// Scale 1 keeps a decimal place, so every cell is a REAL.
	requireRows(t, res, "grams.p0", 50.0, 200.0, 150.0)
}

// A pivot's columns read the same whether or not the detail pass ran.
func TestPivotColumnTypesDoNotDependOnWhetherRowsLoaded(t *testing.T) {
	z := newZoo(t)
	spec := fmt.Sprintf(costBySpeciesAndMonth, "")
	collapsed := z.run(t, "ann", spec, Options{}, nil)
	open := z.run(t, "ann", spec, Options{ExpandAll: true}, nil)
	if !reflect.DeepEqual(collapsed.Columns, open.Columns) {
		t.Fatalf("columns differ:\n%+v\n%+v", collapsed.Columns, open.Columns)
	}
	if c := collapsed.Columns[len(collapsed.Columns)-1]; c.Type != Money || c.TotalType != "" {
		t.Fatalf("last pivot column = %+v", c)
	}
}
