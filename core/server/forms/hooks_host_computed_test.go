package forms

import (
	"net/http"
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

func TestHostHook_NonFiniteResultKeepsTheOtherCustomValues(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "invoice", invoiceDef, false)
	w, err := e.widget(t, form.Id, `{"tax_pct":10,"lines":[{"id":"a","qty":1e200,"rate":1e200},{"id":"b","qty":2,"rate":3}]}`)
	if err != nil {
		t.Fatal(err)
	}
	got := e.storedFields(t, w.Id)
	if got["tax_pct"] != 10.0 {
		t.Fatalf("custom values were lost: %v", got)
	}
	rows, _ := got["lines"].([]any)
	if len(rows) != 2 || rows[0].(map[string]any)["amount"] != 0.0 {
		t.Fatalf("lines = %v, want two rows, the first with amount 0", got["lines"])
	}
	if got["subtotal"] != 6.0 {
		t.Errorf("subtotal = %v, want 6", got["subtotal"])
	}
}

func TestHostHook_AbsentCustomTableReadsAsNoRows(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "invoice", invoiceDef, false)
	w, err := e.widget(t, form.Id, `{"tax_pct":10,"subtotal":999,"tax":5}`)
	if err != nil {
		t.Fatal(err)
	}
	got := e.storedFields(t, w.Id)
	if got["subtotal"] != 0.0 || got["tax"] != 0.0 {
		t.Fatalf("subtotal = %v, tax = %v, want 0 and 0", got["subtotal"], got["tax"])
	}
}

const (
	qtyCol    = `{"key":"qty","kind":"number","label":"Qty"}`
	rateCol   = `{"key":"rate","kind":"number","label":"Rate"}`
	memoCol   = `{"key":"memo","kind":"text","label":"Memo"}`
	amountCol = `{"key":"amount","kind":"computed","label":"Amount","decimals":0,"expression":{"mul":[{"var":"qty"},{"var":"rate"}]}}`
)

// linesDef is a widget form whose custom lines table has the given columns.
func linesDef(columns ...string) string {
	return `{"version":1,"pages":[{"key":"main","title":"Widget"}],"fields":[` + widgetBuiltins + `,` +
		`{"key":"tax_pct","kind":"number","page":"main","label":"Tax","width":"full","required":false,"hidden":false},` +
		`{"key":"lines","kind":"table","page":"main","label":"Lines","width":"full","required":false,"hidden":false,"columns":[` +
		strings.Join(columns, ",") + `]}],"rules":[],"defaults":{},"submit":{"required":[]}}`
}

// saveFields writes fields onto a stored widget through app.Save.
func (e *env) saveFields(t *testing.T, w *core.Record, fields string) error {
	t.Helper()
	w.Set("fields", []byte(fields))
	return e.app.Save(w)
}

func TestHostHook_OldRowKeepsACellOfARemovedColumn(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "lines", linesDef(qtyCol, rateCol, memoCol, amountCol), false)
	w, err := e.widget(t, form.Id, `{"tax_pct":1,"lines":[{"id":"a","qty":2,"rate":3,"memo":"old"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	e.editForm(t, form, ","+memoCol, "")
	e.editForm(t, form, `{"mul":[{"var":"qty"},{"var":"rate"}]}`, `{"mul":[{"var":"qty"},{"var":"rate"},2]}`)

	t.Run("a recompute after a formula edit", func(t *testing.T) {
		if err := e.saveFields(t, w, `{"tax_pct":2,"lines":[{"id":"a","qty":2,"rate":3,"memo":"old","amount":6}]}`); err != nil {
			t.Fatalf("an unrelated update was blocked: %v", err)
		}
		rows := e.storedFields(t, w.Id)["lines"].([]any)
		if rows[0].(map[string]any)["amount"] != 12.0 {
			t.Errorf("amount = %v, want 12", rows[0])
		}
	})
	t.Run("adding a row", func(t *testing.T) {
		if err := e.saveFields(t, w, `{"tax_pct":2,"lines":[{"id":"a","qty":2,"rate":3,"memo":"old","amount":12},{"id":"b","qty":1,"rate":1}]}`); err != nil {
			t.Fatalf("adding a row was blocked: %v", err)
		}
	})
	t.Run("a changed cell in an old row is still checked", func(t *testing.T) {
		cases := []struct{ fields, msg string }{
			{`{"tax_pct":2,"lines":[{"id":"a","qty":2,"rate":3,"memo":"new"}]}`, "Lines has an unknown column memo"},
			{`{"tax_pct":2,"lines":[{"id":"a","qty":"two","rate":3,"memo":"old"}]}`, "Lines: Qty must be a number"},
			{`{"tax_pct":2,"lines":[{"id":"c","qty":1,"memo":"old"}]}`, "Lines has an unknown column memo"},
		}
		for _, c := range cases {
			if err := e.saveFields(t, w, c.fields); err == nil || !strings.Contains(err.Error(), c.msg) {
				t.Errorf("%s: got %v, want %q", c.fields, err, c.msg)
			}
		}
	})
}

func TestHostHook_RequiredColumnIsEnforced(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	requiredRate := `{"key":"rate","kind":"number","label":"Rate","required":true}`
	requiredMemo := `{"key":"memo","kind":"text","label":"Memo","required":true}`
	hiddenNote := `{"key":"note","kind":"text","label":"Note","required":true,"hidden":true}`
	form := e.newForm(t, "lines", linesDef(qtyCol, requiredRate, requiredMemo, hiddenNote), false)
	cases := []struct{ name, fields, msg string }{
		{"missing", `{"lines":[{"id":"a","memo":"m"}]}`, "Rate is required"},
		{"null", `{"lines":[{"id":"a","rate":null,"memo":"m"}]}`, "Rate is required"},
		{"empty text", `{"lines":[{"id":"a","rate":1,"memo":""}]}`, "Memo is required"},
		{"blank text", `{"lines":[{"id":"a","rate":1,"memo":"  "}]}`, "Memo is required"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := e.widget(t, form.Id, c.fields)
			if err == nil || !strings.Contains(err.Error(), c.msg) {
				t.Fatalf("got %v, want %q", err, c.msg)
			}
		})
	}
	t.Run("a hidden required column is not enforced", func(t *testing.T) {
		if _, err := e.widget(t, form.Id, `{"lines":[{"id":"a","rate":0,"memo":"m"}]}`); err != nil {
			t.Fatal(err)
		}
	})
}

func TestHostHook_ColumnMadeRequiredLaterSparesOldRows(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	form := e.newForm(t, "lines", linesDef(qtyCol, rateCol), false)
	w, err := e.widget(t, form.Id, `{"lines":[{"id":"a","qty":2}]}`)
	if err != nil {
		t.Fatal(err)
	}
	e.editForm(t, form, rateCol, `{"key":"rate","kind":"number","label":"Rate","required":true}`)
	if err := e.saveFields(t, w, `{"tax_pct":1,"lines":[{"id":"a","qty":2},{"id":"b","qty":1,"rate":1}]}`); err != nil {
		t.Fatalf("an old row was rejected for a column made required later: %v", err)
	}
	if err := e.saveFields(t, w, `{"lines":[{"id":"a","qty":2},{"id":"c","qty":1}]}`); err == nil || !strings.Contains(err.Error(), "Rate is required") {
		t.Fatalf("a new row must be checked: got %v", err)
	}
}

// gizmoInvoiceTotalX2Def adds a custom computed field over the host's total,
// which reads rows the server never sees.
var gizmoInvoiceTotalX2Def = strings.Replace(gizmoInvoiceDef, `],"rules"`,
	`,{"key":"total_x2","kind":"computed","page":"main","label":"Total x2","width":"full","required":false,"hidden":false,"decimals":0,"expression":{"mul":[{"var":"total"},2]}}],"rules"`, 1)

func (e *env) storedInvoice(t *testing.T, id string) (*core.Record, map[string]any) {
	t.Helper()
	rec, err := e.app.FindRecordById("gizmos_invoices", id)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := fieldsOf(rec, "fields")
	if err != nil {
		t.Fatal(err)
	}
	return rec, fields
}

func TestHostHook_CreateRequestCannotSetHostOwnedValues(t *testing.T) {
	e, _ := invoiceEnv(t)
	e.openCollection(t, "gizmos_invoices")
	form := e.newForm(t, "invoice_x2", gizmoInvoiceTotalX2Def, false)
	e.request(t, http.MethodPost, "/api/collections/gizmos_invoices/records",
		`{"id":"inv000000000001","name":"n","qty":3,"total":5,"form":"`+form.Id+`","fields":{"total_x2":9}}`)
	rec, fields := e.storedInvoice(t, "inv000000000001")
	if got := rec.GetFloat("total"); got != 0 {
		t.Errorf("total = %v, want 0: a request cannot set it", got)
	}
	if _, has := fields["total_x2"]; has {
		t.Errorf("total_x2 = %v, want absent: a request cannot set it", fields["total_x2"])
	}
	if got := rec.GetFloat("doubled"); got != 6 {
		t.Errorf("doubled = %v, want 6: the server still computes what it can", got)
	}
}

func TestHostHook_UpdateRequestCannotSetHostOwnedValues(t *testing.T) {
	e, rec := invoiceEnv(t)
	e.openCollection(t, "gizmos_invoices")
	form := e.newForm(t, "invoice_x2", gizmoInvoiceTotalX2Def, false)
	rec.Set("form", form.Id)
	rec.Set("total", 800)
	rec.Set("fields", []byte(`{"total_x2":1600}`))
	if err := e.app.Save(rec); err != nil {
		t.Fatal(err)
	}
	stored, fields := e.storedInvoice(t, rec.Id)
	if stored.GetFloat("total") != 800 || fields["total_x2"] != 1600.0 {
		t.Fatalf("the host's own save must write: total = %v, total_x2 = %v", stored.Get("total"), fields["total_x2"])
	}
	e.request(t, http.MethodPatch, "/api/collections/gizmos_invoices/records/"+rec.Id,
		`{"name":"renamed","total":1,"fields":{"total_x2":3}}`)
	stored, fields = e.storedInvoice(t, rec.Id)
	if got := stored.GetFloat("total"); got != 800 {
		t.Errorf("total = %v, want 800 kept", got)
	}
	if fields["total_x2"] != 1600.0 {
		t.Errorf("total_x2 = %v, want 1600 kept", fields["total_x2"])
	}
	if stored.GetString("name") != "renamed" {
		t.Errorf("the rest of the patch must still write: name = %q", stored.GetString("name"))
	}
}
