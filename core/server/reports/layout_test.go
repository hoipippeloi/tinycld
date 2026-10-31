package reports

import (
	"fmt"
	"strings"
	"testing"
	"time"
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

// layoutOf is a one-group statement over cost with the given layout items.
func layoutOf(items string) string {
	return `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"species"}],"layout":[` + items + `]}`
}

const lions = `{"section":"cats","title":"Lions","key":"lion"}`

func TestLayoutComputedRowsKeepTheColumnType(t *testing.T) {
	z := newZoo(t)
	third := layoutOf(lions + `,{"row":"r","label":"R","formula":{"op":"div","scale":0,"args":[{"subtotal":"cats"},{"value":3}]}}`)
	res := z.run(t, "ann", third, Options{}, nil)
	// 3500 / 3 rounds to whole cents.
	requireRows(t, res, "cost", int64(3500), int64(3500), int64(1167))

	scaled := layoutOf(lions + `,{"row":"r","label":"R","formula":{"op":"div","scale":2,"args":[{"subtotal":"cats"},{"value":3}]}}`)
	_, err := z.try(t, "ann", scaled, Options{}, nil)
	requireSpecError(t, err, 400, "layout.1.formula.scale", "use scale 0")

	product := layoutOf(lions + `,{"row":"r","label":"R","formula":{"op":"mul","args":[{"subtotal":"cats"},{"subtotal":"cats"}]}}`)
	_, err = z.try(t, "ann", product, Options{}, nil)
	requireSpecError(t, err, 400, "layout.1.formula", "an amount times an amount")

	fraction := layoutOf(lions + `,{"row":"r","label":"R","formula":{"op":"mul","args":[{"subtotal":"cats"},{"value":0.333}]}}`)
	res = z.run(t, "ann", fraction, Options{}, nil)
	requireRows(t, res, "cost", int64(3500), int64(3500), int64(1166))
}

func TestLayoutRefusesAHugeExpansion(t *testing.T) {
	z := newZoo(t)
	items := lions + `,{"row":"r0","label":"R","formula":{"subtotal":"cats"}}`
	for i := 1; i < 30; i++ {
		items += fmt.Sprintf(`,{"row":"r%d","label":"R","formula":{"op":"add","args":[{"subtotal":"r%d"},{"subtotal":"r%d"}]}}`, i, i-1, i-1)
	}
	start := time.Now()
	_, err := z.try(t, "ann", layoutOf(items), Options{}, nil)
	requireSpecError(t, err, 400, "layout.10", "too large")
	if time.Since(start) > 2*time.Second {
		t.Fatalf("refusal took %v", time.Since(start))
	}
}

func TestLayoutBoolSectionKey(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"active","path":[{"link":"animal"},{"field":"active"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"active"}],"layout":[
		{"section":"on","title":"Active","key":true},
		{"row":"r","label":"R","formula":{"subtotal":"on"}}]}`, Options{}, nil)
	requireRows(t, res, "cost", int64(4500), int64(4500), int64(4500))
}

func TestLayoutRefusesBadSectionKeys(t *testing.T) {
	z := newZoo(t)
	object := layoutOf(`{"section":"a","title":"A","key":{"a":1}}`)
	_, err := z.try(t, "ann", object, Options{}, nil)
	requireSpecError(t, err, 400, "layout.0.key", "a section key is")
	spec, _, _ := Load([]byte(object))
	requireSpecError(t, Validate(spec), 400, "layout.0.key", "a section key is")

	twice := layoutOf(lions + `,{"section":"again","title":"Again","key":"lion"}`)
	_, err = z.try(t, "ann", twice, Options{}, nil)
	requireSpecError(t, err, 400, "layout.1.key", "same group")
	spec, _, _ = Load([]byte(twice))
	requireSpecError(t, Validate(spec), 400, "layout.1.key", "same group")
}

func TestLayoutComputedRowsWithNothingVisible(t *testing.T) {
	z := newZoo(t)
	row := `{"row":"r","label":"R","formula":{"op":"add","args":[{"subtotal":"cats"},{"value":5}]}}`
	noRows := `"filter":{"op":"eq","args":[{"path":[{"field":"note"}]},{"value":"no such note"}]},`
	empty := layoutOf(lions + "," + row)
	empty = strings.Replace(empty, `"groups"`, noRows+`"groups"`, 1)
	res := z.run(t, "ann", empty, Options{}, nil)
	requireRows(t, res, "kind", "group", "subtotal", "computed")
	requireRows(t, res, "cost", nil, nil, int64(5))

	// Without a currency column the row reads the same.
	plain := strings.Replace(empty, `"id":"cost","path":[{"field":"cost"}]`, `"id":"cost","path":[{"field":"grams"}]`, 1)
	res = z.run(t, "ann", plain, Options{}, nil)
	requireRows(t, res, "cost", nil, nil, int64(5))
}

func TestLayoutRefusesExists(t *testing.T) {
	z := newZoo(t)
	spec := layoutOf(lions + `,{"row":"r","label":"R","formula":{"op":"exists","link":[{"link":"animal"}],"where":{"value":true}}}`)
	_, err := z.try(t, "ann", spec, Options{}, nil)
	requireSpecError(t, err, 400, "layout.1.formula", "reads sections' subtotals")
}

func TestLayoutRowCapKeepsTheComputedRows(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 2 })
	res := z.run(t, "ann", fmt.Sprintf(zooStatement, ""), Options{}, nil)
	requireRows(t, res, "kind", "group", "subtotal", "group", "subtotal", "group", "subtotal", "computed", "computed")
	requireRows(t, res, "cost", int64(3500), int64(3500), nil, nil, nil, nil, int64(2500), int64(4500))
	if len(res.Notices) != 1 || res.Notices[0].Code != "rowCap" {
		t.Fatalf("notices = %+v", res.Notices)
	}
}
