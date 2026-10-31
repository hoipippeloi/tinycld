package reports

import (
	"fmt"
	"testing"
)

// A statement in the zoo: sections pick first-level groups by key, computed
// rows read the sections' subtotals by name.
const zooStatement = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
	{"id":"grams","path":[{"field":"grams"}],"aggregate":"sum"}],
	"groups":[{"id":"g","col":"species"}],
	%s
	"layout":[
		{"section":"cats","title":"Lions","key":"lion"},
		{"section":"stripes","title":"Zebras","key":"zebra"},
		{"section":"apes","title":"Monkeys","key":"monkey"},
		{"row":"gap","label":"Lions less zebras","formula":{"op":"sub","args":[{"subtotal":"cats"},{"subtotal":"stripes"}]}},
		{"row":"all","label":"All animals","formula":{"op":"add","args":[{"subtotal":"gap"},{"op":"mul","args":[{"subtotal":"stripes"},{"value":2}]},{"subtotal":"apes"}]}}]}`

func TestLayoutSectionsAndComputedRows(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", fmt.Sprintf(zooStatement, ""), Options{}, nil)
	requireRows(t, res, "kind", "group", "subtotal", "group", "subtotal", "group", "subtotal", "computed", "computed")
	requireRows(t, res, "label", "Lions", "Total Lions", "Zebras", "Total Zebras", "Monkeys", "Total Monkeys", "Lions less zebras", "All animals")
	// Ann sees no monkey: its section is empty and counts as zero.
	requireRows(t, res, "cost", int64(3500), int64(3500), int64(1000), int64(1000), nil, nil, int64(2500), int64(4500))
	requireRows(t, res, "grams", int64(1300), int64(1300), int64(400), int64(400), nil, nil, int64(900), int64(1700))
	// A text column has no figure on a computed row, nor on an empty
	// section.
	requireRows(t, res, "species", "lion", "lion", "zebra", "zebra", nil, nil, nil, nil)
	if res.Rows[6].ID != `c:gap:["USD"]` {
		t.Fatalf("computed row id = %q", res.Rows[6].ID)
	}

	open := z.run(t, "ann", fmt.Sprintf(zooStatement, ""), Options{ExpandAll: true}, nil)
	requireRows(t, open, "kind", "group", "detail", "detail", "subtotal", "group", "detail", "detail", "subtotal", "group", "subtotal", "computed", "computed")
}

func TestLayoutComputedRowsSplitThePivot(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", fmt.Sprintf(zooStatement, `"pivot":{"path":[{"field":"fed"}],"bucket":"month","cell":"cost"},`), Options{}, nil)
	requireRows(t, res, "label", "Lions", "Total Lions", "Zebras", "Total Zebras", "Monkeys", "Total Monkeys", "Lions less zebras", "All animals")
	requireRows(t, res, "cost.p0", int64(1000), int64(1000), int64(700), int64(700), nil, nil, int64(300), int64(1700))
	requireRows(t, res, "cost.p2", int64(0), int64(0), int64(300), int64(300), nil, nil, int64(-300), int64(300))
}

func TestLayoutErrors(t *testing.T) {
	z := newZoo(t)
	base := `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"species"}],"layout":[{"section":"cats","title":"Lions","key":"lion"},%s]}`
	cases := map[string]struct {
		row, at, want string
		status        int
	}{
		"unknown section": {`{"row":"r","label":"R","formula":{"subtotal":"dogs"}}`, "layout.1.formula", "no section or earlier row", 422},
		"later row":       {`{"row":"r","label":"R","formula":{"subtotal":"s"}},{"row":"s","label":"S","formula":{"value":1}}`, "layout.1.formula", "no section or earlier row", 422},
		"a column":        {`{"row":"r","label":"R","formula":{"col":"cost"}}`, "layout.1.formula", "reads sections' subtotals", 400},
		"not a number":    {`{"row":"r","label":"R","formula":{"value":"x"}}`, "layout.1.formula", "is a number", 400},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := z.try(t, "ann", fmt.Sprintf(base, c.row), Options{}, nil)
			requireSpecError(t, err, c.status, c.at, c.want)
			spec, _, _ := Load([]byte(fmt.Sprintf(base, c.row)))
			requireSpecError(t, Validate(spec), c.status, c.at, c.want)
		})
	}
}
