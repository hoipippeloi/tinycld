package forms

import (
	"encoding/json"
	"strings"
	"testing"
)

const widgetBuiltins = `{"key":"name","kind":"builtin","page":"main","label":"Name","width":"full","required":true,"hidden":false},
{"key":"notes","kind":"builtin","page":"main","label":"Notes","width":"full","required":false,"hidden":false},
{"key":"due","kind":"builtin","page":"main","label":"Due","width":"full","required":false,"hidden":false},
{"key":"owner","kind":"builtin","page":"main","label":"Owner","width":"full","required":false,"hidden":false},
{"key":"tasks","kind":"builtin","page":"main","label":"Tasks","width":"full","required":false,"hidden":false},
{"key":"comments","kind":"builtin","page":"main","label":"Comments","width":"full","required":false,"hidden":false}`

func testWidgetHost(t *testing.T) *Host {
	t.Helper()
	defs, err := LoadHosts("testdata/form_hosts.json")
	if err != nil {
		t.Fatal(err)
	}
	return defs.Host("gizmos:widget")
}

func defWithFields(extra string) string {
	return `{"version":1,"pages":[{"key":"main","title":"Main"}],"fields":[` + widgetBuiltins + `,` + extra + `],"rules":[],"defaults":{},"submit":{"required":[]}}`
}

func validateJSON(t *testing.T, raw string) string {
	t.Helper()
	def, err := ParseDefinition([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	errs := ValidateDefinition(def, testWidgetHost(t))
	if errs == nil {
		return ""
	}
	b, _ := json.Marshal(errs)
	return string(b)
}

func numField(key string) string {
	return `{"key":"` + key + `","kind":"number","page":"main","label":"` + key + `","width":"full","required":false,"hidden":false}`
}

func computedField(key, expr string) string {
	return `{"key":"` + key + `","kind":"computed","page":"main","label":"` + key + `","width":"full","required":false,"hidden":false,"decimals":0,"expression":` + expr + `}`
}

func tableField(key, columns string) string {
	return `{"key":"` + key + `","kind":"table","page":"main","label":"` + key + `","width":"full","required":false,"hidden":false,"columns":[` + columns + `]}`
}

func column(key, kind, extra string) string {
	if extra != "" {
		extra = "," + extra
	}
	return `{"key":"` + key + `","kind":"` + kind + `","label":"` + key + `"` + extra + `}`
}

func TestValidate_AcceptsAFormulaOverANumberAndATable(t *testing.T) {
	raw := defWithFields(strings.Join([]string{
		numField("a"),
		computedField("b", `{"add":[{"var":"a"},1]}`),
		tableField("lines", column("qty", "number", "")+","+column("amt", "computed", `"decimals":0,"expression":{"mul":[{"var":"qty"},2]}`)),
		computedField("s", `{"sumOf":[{"var":"lines"},"amt"]}`),
		computedField("c", `{"count":[{"var":"lines"}]}`),
	}, ","))
	if got := validateJSON(t, raw); got != "" {
		t.Fatalf("got %s", got)
	}
}

func TestValidate_RejectsBadFormulas(t *testing.T) {
	cases := []struct{ name, fields, want string }{
		{"unknown var", computedField("b", `{"var":"ghost"}`), "unknown field ghost"},
		{"text var", `{"key":"t","kind":"text","page":"main","label":"t","width":"full","required":false,"hidden":false},` + computedField("b", `{"var":"t"}`), "cannot be used in a formula"},
		{"cycle", computedField("a", `{"var":"b"}`) + "," + computedField("b", `{"var":"a"}`), "formula cycle"},
		{"self", computedField("a", `{"add":[{"var":"a"},1]}`), "formula cycle"},
		{"sumOf non-table", numField("n") + "," + computedField("s", `{"sumOf":[{"var":"n"},"x"]}`), "is not a table"},
		{"sumOf unknown column", tableField("lines", column("qty", "number", "")) + "," + computedField("s", `{"sumOf":[{"var":"lines"},"nope"]}`), "unknown column nope"},
		{"sumOf text column", tableField("lines", column("note", "text", "")) + "," + computedField("s", `{"sumOf":[{"var":"lines"},"note"]}`), "is not numeric"},
		{"unknown operator", computedField("b", `{"pow":[2,3]}`), "operator"},
		{"bad arity", computedField("b", `{"sub":[1]}`), "exactly 2"},
		{"bad decimals", computedField("b", `{"round":[1,9]}`), "decimals"},
		{"column aggregate", tableField("lines", column("q", "number", "")+","+column("x", "computed", `"decimals":0,"expression":{"sumOf":[{"var":"lines"},"q"]}`)), "cannot sum or count"},
		{"column unknown", tableField("lines", column("x", "computed", `"decimals":0,"expression":{"var":"zzz"}`)), "unknown column zzz"},
		{"column cycle", tableField("lines", column("a", "computed", `"decimals":0,"expression":{"var":"b"}`)+","+column("b", "computed", `"decimals":0,"expression":{"var":"a"}`)), "formula cycle"},
		{"column id", tableField("lines", column("id", "number", "")), "reserved"},
		{"duplicate column", tableField("lines", column("a", "number", "")+","+column("a", "number", "")), "duplicate column"},
		{"no columns", `{"key":"lines","kind":"table","page":"main","label":"l","width":"full","required":false,"hidden":false,"columns":[]}`, "at least one column"},
		{"bad column kind", tableField("lines", column("a", "markdown", "")), "column kind"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := validateJSON(t, defWithFields(c.fields))
			if !strings.Contains(got, c.want) {
				t.Fatalf("want error containing %q, got %q", c.want, got)
			}
		})
	}
}

func TestOrderKeys(t *testing.T) {
	order, cycle := orderKeys(map[string][]string{"total": {"sub", "tax"}, "tax": {"sub"}, "sub": nil})
	if cycle != nil {
		t.Fatalf("cycle %v", cycle)
	}
	pos := map[string]int{}
	for i, k := range order {
		pos[k] = i
	}
	if !(pos["sub"] < pos["tax"] && pos["tax"] < pos["total"]) {
		t.Fatalf("order %v", order)
	}
	_, cycle = orderKeys(map[string][]string{"a": {"b"}, "b": {"a"}})
	if strings.Join(cycle, ",") != "a,b,a" {
		t.Fatalf("cycle %v", cycle)
	}
	_, cycle = orderKeys(map[string][]string{"a": {"a"}})
	if strings.Join(cycle, ",") != "a,a" {
		t.Fatalf("self cycle %v", cycle)
	}
}
