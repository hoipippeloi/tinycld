package forms

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/rlstest"
)

type env struct {
	app  *tests.TestApp
	defs *Defs
	host *Host
}

// newTestEnv builds the fictional gizmos_widgets host collection, applies
// core's migrations (for `forms`) and binds the forms hooks.
func newTestEnv(t *testing.T) *env {
	t.Helper()
	app := rlstest.NewAssembledApp(t)
	forms, err := app.FindCollectionByNameOrId("forms")
	if err != nil {
		t.Fatal(err)
	}
	widgets := core.NewBaseCollection("gizmos_widgets")
	widgets.Fields.Add(
		&core.TextField{Name: "name", Required: true, Max: 200},
		&core.TextField{Name: "notes"},
		&core.DateField{Name: "due"},
		&core.TextField{Name: "owner"},
		&core.TextField{Name: "position"},
		&core.RelationField{Name: "form", CollectionId: forms.Id, MaxSelect: 1},
		&core.JSONField{Name: "fields", MaxSize: 100000},
	)
	if err := app.Save(widgets); err != nil {
		t.Fatal(err)
	}
	defs, err := LoadHosts(filepath.Join("testdata", "form_hosts.json"))
	if err != nil {
		t.Fatal(err)
	}
	registerCore(app, defs)
	return &env{app: app, defs: defs, host: defs.Host("gizmos:widget")}
}

func (e *env) newForm(t *testing.T, slug string, definition string, isDefault bool) *core.Record {
	t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("forms")
	r := core.NewRecord(col)
	r.Set("host", e.host.Key)
	r.Set("name", slug)
	r.Set("slug", slug)
	r.Set("definition", []byte(definition))
	r.Set("is_default", isDefault)
	r.Set("order", 1)
	if err := e.app.Save(r); err != nil {
		t.Fatalf("save form %s: %v", slug, err)
	}
	return r
}

func (e *env) saveFormErr(t *testing.T, slug string, definition string) error {
	t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("forms")
	r := core.NewRecord(col)
	r.Set("host", e.host.Key)
	r.Set("name", slug)
	r.Set("slug", slug)
	r.Set("definition", []byte(definition))
	r.Set("order", 1)
	return e.app.Save(r)
}

const widgetDefault = `{"version":1,"pages":[{"key":"main","title":"Widget"}],"fields":[
{"key":"name","kind":"builtin","page":"main","label":"Name","width":"full","required":true,"hidden":false},
{"key":"notes","kind":"builtin","page":"main","label":"Notes","width":"full","required":false,"hidden":false},
{"key":"due","kind":"builtin","page":"main","label":"Due","width":"full","required":false,"hidden":false},
{"key":"owner","kind":"builtin","page":"main","label":"Owner","width":"full","required":false,"hidden":false},
{"key":"tasks","kind":"builtin","page":"main","label":"Tasks","width":"full","required":false,"hidden":false},
{"key":"comments","kind":"builtin","page":"main","label":"Comments","width":"full","required":false,"hidden":false}
],"rules":[],"defaults":{},"submit":{"required":[]}}`

func withField(def, field string) string {
	return strings.Replace(def, `{"key":"comments"`, field+`,{"key":"comments"`, 1)
}

func TestFormsHook_AcceptsTheDefaultDefinition(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
}

func TestFormsHook_RejectsUnknownHost(t *testing.T) {
	e := newTestEnv(t)
	col, _ := e.app.FindCollectionByNameOrId("forms")
	r := core.NewRecord(col)
	r.Set("host", "gizmos:ghost")
	r.Set("name", "x")
	r.Set("slug", "x")
	r.Set("definition", []byte(widgetDefault))
	err := e.app.Save(r)
	if err == nil || !strings.Contains(err.Error(), "host") {
		t.Fatalf("want a host error, got %v", err)
	}
}

func TestFormsHook_RejectsMissingBuiltin(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `{"key":"due","kind":"builtin","page":"main","label":"Due","width":"full","required":false,"hidden":false},`, "", 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "missing built-in field due") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsCustomKeyThatIsAColumn(t *testing.T) {
	e := newTestEnv(t)
	def := withField(widgetDefault, `{"key":"position","kind":"text","page":"main","label":"P","width":"full","required":false,"hidden":false}`)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "position is a column") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsHiddenRequiredBuiltin(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `"label":"Name","width":"full","required":true,"hidden":false`, `"label":"Name","width":"full","required":true,"hidden":true`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "cannot be hidden") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsRuleOnMissingField(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `"rules":[]`, `"rules":[{"key":"r","match":"all","when":[{"field":"ghost","op":"is","value":"x"}],"actions":[{"action":"hide","field":"due"}]}]`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "unknown field ghost") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsBadOperatorForKind(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `"rules":[]`, `"rules":[{"key":"r","match":"all","when":[{"field":"due","op":"contains","value":"x"}],"actions":[{"action":"hide","field":"owner"}]}]`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "contains is not valid for a date field") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_OneDefaultPerHost(t *testing.T) {
	e := newTestEnv(t)
	a := e.newForm(t, "a", widgetDefault, true)
	b := e.newForm(t, "b", widgetDefault, true)
	a, _ = e.app.FindRecordById("forms", a.Id)
	if a.GetBool("is_default") {
		t.Fatal("setting b as default must clear a")
	}
	b.Set("is_default", false)
	if err := e.app.Save(b); err == nil || !strings.Contains(err.Error(), "another form") {
		t.Fatalf("unsetting the only default must be refused, got %v", err)
	}
}

func TestFormsHook_DeleteGuards(t *testing.T) {
	e := newTestEnv(t)
	a := e.newForm(t, "a", widgetDefault, true)
	if err := e.app.Delete(a); err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("deleting the default must be refused, got %v", err)
	}
	b := e.newForm(t, "b", widgetDefault, false)
	widgets, _ := e.app.FindCollectionByNameOrId("gizmos_widgets")
	w := core.NewRecord(widgets)
	w.Set("name", "w")
	w.Set("form", b.Id)
	if err := e.app.Save(w); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Delete(b); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("deleting a form with records must be refused, got %v", err)
	}
	if err := e.app.Delete(w); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Delete(b); err != nil {
		t.Fatalf("an unused non-default form deletes: %v", err)
	}
}

func TestFormsHook_RejectsDuplicateRuleKey(t *testing.T) {
	e := newTestEnv(t)
	rule := `{"key":"r","match":"all","when":[{"field":"name","op":"is_empty"}],"actions":[{"action":"hide","field":"due"}]}`
	def := strings.Replace(widgetDefault, `"rules":[]`, `"rules":[`+rule+`,`+rule+`]`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "duplicate rule key r") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsNonTextContainsValue(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `"rules":[]`, `"rules":[{"key":"r","match":"all","when":[{"field":"name","op":"contains","value":5}],"actions":[{"action":"hide","field":"due"}]}]`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "contains needs a text value") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsNonTextStartsWithValue(t *testing.T) {
	e := newTestEnv(t)
	def := strings.Replace(widgetDefault, `"rules":[]`, `"rules":[{"key":"r","match":"all","when":[{"field":"name","op":"starts_with"}],"actions":[{"action":"hide","field":"due"}]}]`, 1)
	err := e.saveFormErr(t, "bad", def)
	if err == nil || !strings.Contains(err.Error(), "starts_with needs a text value") {
		t.Fatalf("got %v", err)
	}
}

func TestFormsHook_RejectsBadIsAnyOfValue(t *testing.T) {
	e := newTestEnv(t)
	def := withField(widgetDefault, `{"key":"sev","kind":"select","page":"main","label":"S","width":"full","required":false,"hidden":false,"options":[{"value":"a","label":"A"}]}`)
	for _, v := range []string{`[]`, `"a"`, `[1]`} {
		bad := strings.Replace(def, `"rules":[]`, `"rules":[{"key":"r","match":"all","when":[{"field":"sev","op":"is_any_of","value":`+v+`}],"actions":[{"action":"hide","field":"due"}]}]`, 1)
		err := e.saveFormErr(t, "bad", bad)
		if err == nil || !strings.Contains(err.Error(), "is_any_of needs a list") {
			t.Fatalf("value %s: got %v", v, err)
		}
	}
}

func TestFormsHook_SettlingSiblingFiresUpdateHook(t *testing.T) {
	e := newTestEnv(t)
	calls := 0
	e.app.OnRecordUpdate("forms").BindFunc(func(ev *core.RecordEvent) error {
		calls++
		return ev.Next()
	})
	a := e.newForm(t, "a", widgetDefault, true)
	e.newForm(t, "b", widgetDefault, true)
	if calls < 1 {
		t.Fatalf("sibling clear must fire the update hook, calls=%d", calls)
	}
	a, _ = e.app.FindRecordById("forms", a.Id)
	if a.GetBool("is_default") {
		t.Fatal("a must no longer be default")
	}
}
