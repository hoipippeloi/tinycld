package reports

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func day(s string) time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestRangePresetsMatchTheShell(t *testing.T) {
	july := periodContext{today: day("2026-08-15"), fiscalStart: 7}
	january := periodContext{today: day("2026-02-10"), fiscalStart: 1}
	cases := []struct {
		preset   string
		pc       periodContext
		from, to string
	}{
		{"today", july, "2026-08-15", "2026-08-15"},
		{"thisMonth", july, "2026-08-01", "2026-08-31"},
		{"thisMonthToDate", july, "2026-08-01", "2026-08-15"},
		{"thisQuarter", july, "2026-07-01", "2026-09-30"},
		{"thisQuarterToDate", july, "2026-07-01", "2026-08-15"},
		{"thisFiscalYear", july, "2026-07-01", "2027-06-30"},
		{"thisFiscalYearToDate", july, "2026-07-01", "2026-08-15"},
		{"lastMonth", july, "2026-07-01", "2026-07-31"},
		{"lastQuarter", july, "2026-04-01", "2026-06-30"},
		{"lastFiscalYear", july, "2025-07-01", "2026-06-30"},
		{"last12Months", july, "2025-08-01", "2026-07-31"},
		{"thisQuarter", january, "2026-01-01", "2026-03-31"},
		{"lastMonth", january, "2026-01-01", "2026-01-31"},
		{"lastFiscalYear", january, "2025-01-01", "2025-12-31"},
		{"lastQuarter", january, "2025-10-01", "2025-12-31"},
	}
	for _, c := range cases {
		from, to := rangeDays(c.preset, c.pc)
		if from != c.from || to != c.to {
			t.Errorf("%s (fiscal start %d): %s..%s, want %s..%s", c.preset, c.pc.fiscalStart, from, to, c.from, c.to)
		}
	}
}

func TestAsOfPresetsMatchTheShell(t *testing.T) {
	july := periodContext{today: day("2026-08-15"), fiscalStart: 7}
	cases := map[string]string{
		"today":               "2026-08-15",
		"endOfLastMonth":      "2026-07-31",
		"endOfLastQuarter":    "2026-06-30",
		"endOfLastFiscalYear": "2026-06-30",
	}
	for preset, want := range cases {
		if got := asOfDay(preset, july); got != want {
			t.Errorf("%s = %s, want %s", preset, got, want)
		}
	}
}

func raws(m map[string]string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for k, v := range m {
		out[k] = json.RawMessage(v)
	}
	return out
}

var zooParams = []ParamDef{
	{ID: "period", Type: ParamDateRange, Default: json.RawMessage(`{"preset":"thisMonth"}`)},
	{ID: "asOf", Type: ParamAsOf},
	{ID: "kind", Type: ParamChoice, Options: []Option{{Value: "hay", Label: "Hay"}, {Value: "fish", Label: "Fish"}}},
	{ID: "kinds", Type: ParamChoice, Multiple: true, Options: []Option{{Value: "hay", Label: "Hay"}, {Value: "fish", Label: "Fish"}}},
	{ID: "note", Type: ParamText},
	{ID: "min", Type: ParamNumber},
}

func TestResolveParamsTakesPostedThenDefaultThenUnset(t *testing.T) {
	pc := periodContext{today: day("2026-08-15"), fiscalStart: 1}
	got, err := resolveParams(zooParams, raws(map[string]string{
		"asOf": `{"preset":"endOfLastMonth"}`, "kinds": `["fish","hay"]`, "min": `2.5`, "note": `"x"`,
	}), pc)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]paramValue{
		"period": {typ: ParamDateRange, from: "2026-08-01", to: "2026-08-31"},
		"asOf":   {typ: ParamAsOf, value: "2026-07-31"},
		"kind":   {typ: ParamChoice, unset: true},
		"kinds":  {typ: ParamChoice, multiple: true, list: []string{"fish", "hay"}},
		"note":   {typ: ParamText, value: "x"},
		"min":    {typ: ParamNumber, value: 2.5},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestResolveParamsRefusesBadValues(t *testing.T) {
	pc := periodContext{today: day("2026-08-15"), fiscalStart: 1}
	cases := map[string]struct {
		given    map[string]string
		at, want string
	}{
		"undeclared":     {map[string]string{"color": `"red"`}, "params.color", `no param "color"`},
		"not a day":      {map[string]string{"asOf": `"2026-02-30"`}, "params.asOf", "YYYY-MM-DD"},
		"before 1900":    {map[string]string{"asOf": `"1899-12-31"`}, "params.asOf", "YYYY-MM-DD"},
		"range preset":   {map[string]string{"asOf": `{"preset":"thisMonth"}`}, "params.asOf", "a date or a preset"},
		"backward range": {map[string]string{"period": `{"from":"2026-02-01","to":"2026-01-01"}`}, "params.period", "on or before"},
		"range keys":     {map[string]string{"period": `{"from":"2026-02-01"}`}, "params.period", "a date range is"},
		"choice":         {map[string]string{"kind": `"meat"`}, "params.kind", "one of the param's options"},
		"multiple":       {map[string]string{"kinds": `"hay"`}, "params.kinds", "a list of the param's options"},
		"long text":      {map[string]string{"note": `"` + strings.Repeat("x", 501) + `"`}, "params.note", "at most 500"},
		"number":         {map[string]string{"min": `"2"`}, "params.min", "a number"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := resolveParams(zooParams, raws(c.given), pc)
			requireSpecError(t, err, 400, c.at, c.want)
		})
	}
}

func TestCheckParamDefsRefusesBadDeclarations(t *testing.T) {
	cases := map[string]struct {
		defs     []ParamDef
		at, want string
	}{
		"duplicate id":   {[]ParamDef{{ID: "a", Type: ParamText}, {ID: "a", Type: ParamText}}, "params.1.id", "unique id"},
		"unknown type":   {[]ParamDef{{ID: "a", Type: "color"}}, "params.0.type", `unknown param type "color"`},
		"choice options": {[]ParamDef{{ID: "a", Type: ParamChoice}}, "params.0.options", "lists its options"},
		"text options":   {[]ParamDef{{ID: "a", Type: ParamText, Options: []Option{{Value: "x", Label: "X"}}}}, "params.0", "only a choice param"},
		"bad default":    {[]ParamDef{{ID: "a", Type: ParamDateRange, Default: json.RawMessage(`{"preset":"someday"}`)}}, "params.0.default", "the preset is one of"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			requireSpecError(t, checkParamDefs(c.defs), 400, c.at, c.want)
		})
	}
	if err := checkParamDefs(zooParams); err != nil {
		t.Fatalf("zoo params: %v", err)
	}
}
