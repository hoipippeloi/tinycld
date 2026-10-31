package reports

import (
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newPlainApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// sqlValue runs one SELECT expression through SQLite, so each case goes
// through the registered function exactly as compiled SQL calls it.
func sqlValue(t *testing.T, app core.App, expr string, params dbx.Params) (any, error) {
	t.Helper()
	var out struct {
		V any `db:"v"`
	}
	err := app.DB().NewQuery("SELECT " + expr + " AS v").Bind(params).One(&out)
	return out.V, err
}

func TestDivRoundsHalfAwayFromZeroExactly(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		name  string
		a, b  any
		scale int64
		want  any
	}{
		{"exact", int64(10), int64(2), 0, int64(5)},
		{"half up", int64(5), int64(2), 0, int64(3)},
		{"half away below zero", int64(-5), int64(2), 0, int64(-3)},
		{"negative divisor", int64(5), int64(-2), 0, int64(-3)},
		{"below half", int64(4), int64(3), 0, int64(1)},
		{"scale 2", int64(1), int64(3), 2, 0.33},
		{"scale 4 ratio", int64(1234), int64(5000), 4, 0.2468},
		{"near 2^53 stays exact", int64(9007199254740991), int64(2), 0, int64(4503599627370496)},
		{"zero divisor is 0", int64(7), int64(0), 2, int64(0)},
		{"real operand divides in float", 7.5, int64(2), 1, 3.8},
		{"real half away", 2.5, int64(1), 0, int64(3)},
		{"null in null out", nil, int64(2), 0, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := sqlValue(t, app, "tc_div({:a}, {:b}, {:s})", dbx.Params{"a": c.a, "b": c.b, "s": c.scale})
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("tc_div(%v, %v, %d) = %#v, want %#v", c.a, c.b, c.scale, got, c.want)
			}
		})
	}
}

func TestDivOverflowIsAnIntegerOverflowError(t *testing.T) {
	app := newPlainApp(t)
	_, err := sqlValue(t, app, "tc_div({:a}, 1, 0) * 1", dbx.Params{"a": int64(9223372036854775807)})
	if err != nil {
		t.Fatalf("a quotient that fits must not fail: %v", err)
	}
	_, err = sqlValue(t, app, "tc_pct({:a}, 1, 0)", dbx.Params{"a": int64(9223372036854775807)})
	if err == nil || !strings.Contains(err.Error(), "integer overflow") {
		t.Fatalf("err = %v, want integer overflow", err)
	}
}

func TestPctHasNoFigureWithoutAWhole(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		name        string
		part, whole any
		want        any
	}{
		{"quarter", int64(25), int64(100), 25.0},
		{"third at scale 1", int64(1), int64(3), 33.3},
		{"zero whole", int64(5), int64(0), nil},
		{"null whole", int64(5), nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := sqlValue(t, app, "tc_pct({:p}, {:w}, 1)", dbx.Params{"p": c.part, "w": c.whole})
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("tc_pct = %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestRoundKeepsIntegersAndRoundsReals(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		x     any
		scale int64
		want  any
	}{
		{int64(1234), 2, int64(1234)},
		{2.345, 2, 2.35},
		{-2.5, 0, int64(-3)},
		{nil, 0, nil},
	}
	for _, c := range cases {
		got, err := sqlValue(t, app, "tc_round({:x}, {:s})", dbx.Params{"x": c.x, "s": c.scale})
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("tc_round(%v, %d) = %#v, want %#v", c.x, c.scale, got, c.want)
		}
	}
}

func TestScaleOutOfRangeIsAnError(t *testing.T) {
	app := newPlainApp(t)
	for _, expr := range []string{"tc_div(1, 2, 7)", "tc_round(1.5, -1)", "tc_pct(1, 2, 'x')"} {
		if _, err := sqlValue(t, app, expr, nil); err == nil {
			t.Errorf("%s: no error", expr)
		}
	}
}

func TestFiscalYearAndPeriod(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		day          any
		start        int64
		year, period any
	}{
		{"2026-01-15 00:00:00.000Z", 1, int64(2026), int64(1)},
		{"2026-12-31", 1, int64(2026), int64(12)},
		{"2026-06-30", 7, int64(2026), int64(12)},
		{"2026-07-01 08:00:00.000Z", 7, int64(2027), int64(1)},
		{"2025-12-01", 4, int64(2026), int64(9)},
		{"", 7, nil, nil},
		{nil, 7, nil, nil},
	}
	for _, c := range cases {
		params := dbx.Params{"d": c.day, "m": c.start}
		year, err := sqlValue(t, app, "tc_fiscal_year({:d}, {:m})", params)
		if err != nil {
			t.Fatal(err)
		}
		period, err := sqlValue(t, app, "tc_fiscal_period({:d}, {:m})", params)
		if err != nil {
			t.Fatal(err)
		}
		if year != c.year || period != c.period {
			t.Errorf("%v start %d: year %#v period %#v, want %#v %#v", c.day, c.start, year, period, c.year, c.period)
		}
	}
	if _, err := sqlValue(t, app, "tc_fiscal_year('2026-01-01', 13)", nil); err == nil {
		t.Error("start month 13 must fail")
	}
}

func TestAddMonthsHoldsTheMonthEnd(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		day  any
		n    any
		want any
	}{
		{"2026-01-31", int64(1), "2026-02-28"},
		{"2024-01-31 00:00:00.000Z", int64(1), "2024-02-29"},
		{"2026-03-15", int64(-3), "2025-12-15"},
		{"2026-03-31", int64(12), "2027-03-31"},
		{"2026-03-31", nil, "2026-03-31"},
		{"", int64(1), nil},
	}
	for _, c := range cases {
		got, err := sqlValue(t, app, "tc_add_months({:d}, {:n})", dbx.Params{"d": c.day, "n": c.n})
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("tc_add_months(%v, %v) = %#v, want %#v", c.day, c.n, got, c.want)
		}
	}
}
