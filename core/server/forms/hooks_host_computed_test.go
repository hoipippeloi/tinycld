package forms

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
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
	cases := []struct{ name, fields, msg string }{
		{"no id", `{"lines":[{"qty":1}]}`, "Lines has a row without an id"},
		{"non-string id", `{"lines":[{"id":1}]}`, "Lines has a row without an id"},
		{"unknown column", `{"lines":[{"id":"a","ghost":1}]}`, "Lines has an unknown column ghost"},
		{"text for number", `{"lines":[{"id":"a","qty":"two"}]}`, "Lines: Qty must be a number"},
		{"not a list", `{"lines":"x"}`, "Lines must be a list of rows"},
		{"row not object", `{"lines":["x"]}`, "Lines has a bad row"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := e.widget(t, form.Id, c.fields)
			if err == nil || !strings.Contains(err.Error(), "lines") || !strings.Contains(err.Error(), c.msg) {
				t.Fatalf("got %v, want message %q", err, c.msg)
			}
		})
	}
}

const gizmoInvoiceDef = `{"version":1,"pages":[{"key":"main","title":"Invoice"}],"fields":[` +
	`{"key":"name","kind":"builtin","page":"main","label":"Name","width":"full","required":false,"hidden":false},` +
	`{"key":"qty","kind":"builtin","page":"main","label":"Qty","width":"full","required":false,"hidden":false},` +
	`{"key":"doubled","kind":"builtin","page":"main","label":"Doubled","width":"full","required":false,"hidden":false},` +
	`{"key":"lines","kind":"builtin","page":"main","label":"Lines","width":"full","required":false,"hidden":false},` +
	`{"key":"total","kind":"builtin","page":"main","label":"Total","width":"full","required":false,"hidden":false}],` +
	`"rules":[],"defaults":{},"submit":{"required":[]}}`

// invoiceEnv adds the fictional gizmos_invoices collection, whose lines live
// in another collection (storage "rows") and are therefore never in a write.
func invoiceEnv(t *testing.T) (*env, *core.Record) {
	t.Helper()
	e := newTestEnv(t)
	forms, err := e.app.FindCollectionByNameOrId("forms")
	if err != nil {
		t.Fatal(err)
	}
	invoices := core.NewBaseCollection("gizmos_invoices")
	invoices.Fields.Add(
		&core.TextField{Name: "name"},
		&core.NumberField{Name: "qty"},
		&core.NumberField{Name: "doubled"},
		&core.NumberField{Name: "total"},
		&core.RelationField{Name: "form", CollectionId: forms.Id, MaxSelect: 1},
		&core.JSONField{Name: "fields", MaxSize: 100000},
	)
	if err := e.app.Save(invoices); err != nil {
		t.Fatal(err)
	}
	e.host = e.defs.Host("gizmos:invoice")
	form := e.newForm(t, "invoice", gizmoInvoiceDef, true)
	rec := core.NewRecord(invoices)
	rec.Set("name", "first")
	rec.Set("qty", 4)
	rec.Set("total", 777)
	rec.Set("form", form.Id)
	rec.Set("fields", []byte(`{}`))
	if err := e.app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return e, rec
}

func TestHostHook_RecomputesHostComputedColumn(t *testing.T) {
	_, rec := invoiceEnv(t)
	if got := rec.GetFloat("doubled"); got != 8 {
		t.Errorf("doubled = %v, want 8", got)
	}
}

func TestHostHook_KeepsHostComputedOverRowsTableOutsideWrite(t *testing.T) {
	e, rec := invoiceEnv(t)
	rec.Set("name", "renamed")
	rec.Set("qty", 5)
	if err := e.app.Save(rec); err != nil {
		t.Fatal(err)
	}
	stored, err := e.app.FindRecordById("gizmos_invoices", rec.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := stored.Get("total"); got != 777.0 {
		t.Errorf("total = %#v, want 777.0 untouched", got)
	}
	if got := stored.GetFloat("doubled"); got != 10 {
		t.Errorf("doubled = %v, want 10", got)
	}
}
