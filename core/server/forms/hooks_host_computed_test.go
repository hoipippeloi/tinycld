package forms

import (
	"strings"
	"testing"
)

const invoiceFieldsJSON = `{"key":"tax_pct","kind":"number","page":"main","label":"Tax","width":"full","required":false,"hidden":false},
{"key":"lines","kind":"table","page":"main","label":"Lines","width":"full","required":false,"hidden":false,"columns":[
{"key":"qty","kind":"number","label":"Qty"},
{"key":"rate","kind":"number","label":"Rate"},
{"key":"amount","kind":"computed","label":"Amount","decimals":0,"expression":{"mul":[{"var":"qty"},{"var":"rate"}]}}]},
{"key":"subtotal","kind":"computed","page":"main","label":"Subtotal","width":"full","required":false,"hidden":false,"decimals":0,"expression":{"sumOf":[{"var":"lines"},"amount"]}},
{"key":"tax","kind":"computed","page":"main","label":"Tax amount","width":"full","required":false,"hidden":false,"decimals":0,"expression":{"round":[{"div":[{"mul":[{"var":"subtotal"},{"var":"tax_pct"}]},100]},0]}}`

var invoiceDef = `{"version":1,"pages":[{"key":"main","title":"Widget"}],"fields":[` + widgetBuiltins + `,` + invoiceFieldsJSON + `],"rules":[],"defaults":{},"submit":{"required":[]}}`

func TestHostHook_RecomputesAndOverwritesComputedValues(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "invoice", invoiceDef, false)
	w, err := e.widget(t, form.Id, `{"tax_pct":10,"lines":[{"id":"a","qty":2,"rate":1999},{"id":"b","qty":1,"rate":2}],"subtotal":1,"tax":1}`)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := fieldsOf(w, "fields")
	if err != nil {
		t.Fatal(err)
	}
	if fields["subtotal"] != 4000.0 {
		t.Errorf("subtotal = %v, want 4000", fields["subtotal"])
	}
	if fields["tax"] != 400.0 {
		t.Errorf("tax = %v, want 400", fields["tax"])
	}
	rows := fields["lines"].([]any)
	if rows[0].(map[string]any)["amount"] != 3998.0 {
		t.Errorf("row amount = %v, want 3998", rows[0])
	}
}

func TestHostHook_RecomputesOnUpdate(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "invoice", invoiceDef, false)
	w, err := e.widget(t, form.Id, `{"tax_pct":10,"lines":[{"id":"a","qty":1,"rate":100}]}`)
	if err != nil {
		t.Fatal(err)
	}
	w.Set("fields", []byte(`{"tax_pct":10,"lines":[{"id":"a","qty":3,"rate":100}],"subtotal":1}`))
	if err := e.app.Save(w); err != nil {
		t.Fatal(err)
	}
	fields, _ := fieldsOf(w, "fields")
	if fields["subtotal"] != 300.0 {
		t.Errorf("subtotal = %v, want 300", fields["subtotal"])
	}
}

func TestHostHook_RejectsBadTableRows(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "invoice", invoiceDef, false)
	cases := map[string]string{
		"no id":           `{"lines":[{"qty":1}]}`,
		"unknown column":  `{"lines":[{"id":"a","ghost":1}]}`,
		"text for number": `{"lines":[{"id":"a","qty":"two"}]}`,
		"not a list":      `{"lines":"x"}`,
		"row not object":  `{"lines":["x"]}`,
	}
	for name, fields := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := e.widget(t, form.Id, fields); err == nil || !strings.Contains(err.Error(), "lines") {
				t.Fatalf("got %v", err)
			}
		})
	}
}
