package forms

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

const bugDef = `{"version":1,"pages":[{"key":"main","title":"Bug"},{"key":"repro","title":"Repro"}],"fields":[
{"key":"name","kind":"builtin","page":"main","label":"Name","width":"full","required":true,"hidden":false},
{"key":"notes","kind":"builtin","page":"main","label":"Notes","width":"full","required":false,"hidden":false},
{"key":"due","kind":"builtin","page":"main","label":"Due","width":"full","required":false,"hidden":false},
{"key":"owner","kind":"builtin","page":"main","label":"Owner","width":"full","required":false,"hidden":false},
{"key":"tasks","kind":"builtin","page":"main","label":"Tasks","width":"full","required":false,"hidden":false},
{"key":"comments","kind":"builtin","page":"main","label":"Comments","width":"full","required":false,"hidden":false},
{"key":"severity","kind":"select","page":"main","label":"Severity","width":"third","required":false,"hidden":false,"display":"dropdown","multiple":false,"options":[{"value":"low","label":"Low"},{"value":"high","label":"High"}]},
{"key":"steps","kind":"textarea","page":"repro","label":"Steps","width":"full","required":false,"hidden":false},
{"key":"nick","kind":"text","page":"main","label":"Nick","width":"full","required":false,"hidden":false,"maxLength":5},
{"key":"tags","kind":"select","page":"main","label":"Tags","width":"full","required":false,"hidden":false,"display":"dropdown","multiple":true,"options":[{"value":"a","label":"A"}]},
{"key":"assignee","kind":"user","page":"main","label":"Assignee","width":"full","required":false,"hidden":false},
{"key":"flag","kind":"toggle","page":"main","label":"Flag","width":"full","required":false,"hidden":false},
{"key":"todo","kind":"checklist","page":"main","label":"Todo","width":"full","required":false,"hidden":false},
{"key":"body","kind":"markdown","page":"main","label":"Body","width":"full","required":false,"hidden":false,"collaborative":true,"maxLength":5},
{"key":"count","kind":"number","page":"main","label":"Count","width":"full","required":false,"hidden":false,"min":0,"max":10}
],"rules":[{"key":"r","match":"all","when":[{"field":"severity","op":"is","value":"high"}],"actions":[{"action":"require","field":"steps"}]}],
"defaults":{},"submit":{"required":[]}}`

func (e *env) widget(t *testing.T, formID string, fields string) (*core.Record, error) {
	t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("gizmos_widgets")
	r := core.NewRecord(col)
	r.Set("name", "w")
	if formID != "" {
		r.Set("form", formID)
	}
	if fields != "" {
		r.Set("fields", []byte(fields))
	}
	return r, e.app.Save(r)
}

func TestHostHook_FillsTheDefaultFormWhenEmpty(t *testing.T) {
	e := newTestEnv(t)
	def := e.newForm(t, "widget", widgetDefault, true)
	w, err := e.widget(t, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if w.GetString("form") != def.Id {
		t.Fatalf("form = %q, want the default %q", w.GetString("form"), def.Id)
	}
}

func TestHostHook_RejectsAFormOfAnotherHost(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	col, _ := e.app.FindCollectionByNameOrId("forms")
	other := core.NewRecord(col)
	other.Set("host", "gizmos:other")
	other.Set("name", "o")
	other.Set("slug", "o")
	other.Set("order", 1)
	other.Set("definition", []byte(`{"version":1,"pages":[{"key":"main","title":"Other"}],"fields":[{"key":"name","kind":"builtin","page":"main","label":"Name","width":"full","required":true,"hidden":false}],"rules":[],"defaults":{},"submit":{"required":[]}}`))
	if err := e.app.Save(other); err != nil {
		t.Fatal(err)
	}
	_, err := e.widget(t, other.Id, "")
	if err == nil || !strings.Contains(err.Error(), "validation_unknown_form") && !strings.Contains(err.Error(), "form:") {
		t.Fatalf("got %v", err)
	}
}

func TestHostHook_RejectsUnknownKeyAndWrongKind(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	if _, err := e.widget(t, bug.Id, `{"ghost":1}`); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("unknown key: got %v", err)
	}
	if _, err := e.widget(t, bug.Id, `{"count":"many"}`); err == nil || !strings.Contains(err.Error(), "count") {
		t.Fatalf("wrong kind: got %v", err)
	}
	if _, err := e.widget(t, bug.Id, `{"severity":"nope"}`); err == nil || !strings.Contains(err.Error(), "severity") {
		t.Fatalf("bad option: got %v", err)
	}
	if _, err := e.widget(t, bug.Id, `{"count":11}`); err == nil || !strings.Contains(err.Error(), "count") {
		t.Fatalf("over max: got %v", err)
	}
}

func TestHostHook_RuleRequiredOnCreate(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	if _, err := e.widget(t, bug.Id, `{"severity":"high"}`); err == nil || !strings.Contains(err.Error(), "steps") {
		t.Fatalf("high severity without steps must be refused, got %v", err)
	}
	if _, err := e.widget(t, bug.Id, `{"severity":"high","steps":"1. open"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.widget(t, bug.Id, `{"severity":"low"}`); err != nil {
		t.Fatal(err)
	}
}

func TestHostHook_UpdateCannotClearARequiredField(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	w, err := e.widget(t, bug.Id, `{"severity":"high","steps":"1. open"}`)
	if err != nil {
		t.Fatal(err)
	}
	w.Set("fields", []byte(`{"severity":"high","steps":""}`))
	if err := e.app.Save(w); err == nil || !strings.Contains(err.Error(), "steps") {
		t.Fatalf("clearing steps must be refused, got %v", err)
	}
	w.Set("fields", []byte(`{"severity":"high","steps":"1. open","count":3}`))
	if err := e.app.Save(w); err != nil {
		t.Fatal(err)
	}
}

func TestHostHook_KeepsValuesOfAnotherFormAfterTypeChange(t *testing.T) {
	e := newTestEnv(t)
	plain := e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	w, err := e.widget(t, bug.Id, `{"severity":"low","count":2}`)
	if err != nil {
		t.Fatal(err)
	}
	w.Set("form", plain.Id)
	if err := e.app.Save(w); err != nil {
		t.Fatalf("a type change must keep orphan keys, got %v", err)
	}
}

func TestHostHook_RejectsBuiltinKeysInJSON(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	for _, key := range []string{"tasks", "notes"} {
		if _, err := e.widget(t, bug.Id, `{"`+key+`":"anything"}`); err == nil || !strings.Contains(err.Error(), key) {
			t.Fatalf("builtin %s never travels in the json column, got %v", key, err)
		}
	}
}

func TestDefaultFormIDFrom(t *testing.T) {
	if id, err := defaultFormIDFrom(nil, sql.ErrNoRows); id != "" || err != nil {
		t.Fatalf("no rows must mean no default, got %q %v", id, err)
	}
	if _, err := defaultFormIDFrom(nil, errors.New("boom")); err == nil {
		t.Fatal("a database error must propagate")
	}
}

func TestHostHook_RejectsEmptyFormWhenNoDefaultButFormsExist(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "a", widgetDefault, false)
	_, err := e.widget(t, "", "")
	if err == nil || !strings.Contains(err.Error(), "form") {
		t.Fatalf("got %v", err)
	}
}

func TestHostHook_ChecksKindOfCollaborativeCustomField(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	if _, err := e.widget(t, bug.Id, `{"body":3}`); err == nil || !strings.Contains(err.Error(), "body") {
		t.Fatalf("number in a text field, got %v", err)
	}
	if _, err := e.widget(t, bug.Id, `{"body":"ok"}`); err != nil {
		t.Fatal(err)
	}
}

func TestHostHook_RuleMadeRequiredByAnUpdateIsEnforced(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	w, err := e.widget(t, bug.Id, `{"severity":"low"}`)
	if err != nil {
		t.Fatal(err)
	}
	w.Set("fields", []byte(`{"severity":"low","count":1}`))
	if err := e.app.Save(w); err != nil {
		t.Fatalf("unrelated update must pass, got %v", err)
	}
	w.Set("fields", []byte(`{"severity":"high"}`))
	if err := e.app.Save(w); err == nil || !strings.Contains(err.Error(), "steps") {
		t.Fatalf("becoming required must be enforced, got %v", err)
	}
}

func TestHostHook_CheckKindBranches(t *testing.T) {
	e := newTestEnv(t)
	e.newForm(t, "widget", widgetDefault, true)
	bug := e.newForm(t, "bug", bugDef, false)
	cases := map[string]string{
		"tags":     `{"tags":"a"}`,
		"assignee": `{"assignee":5}`,
		"flag":     `{"flag":"yes"}`,
		"todo":     `{"todo":[{"title":"x"}]}`,
		"nick":     `{"nick":"toolong"}`,
	}
	for key, fields := range cases {
		if _, err := e.widget(t, bug.Id, fields); err == nil || !strings.Contains(err.Error(), key) {
			t.Fatalf("%s: got %v", key, err)
		}
	}
}
