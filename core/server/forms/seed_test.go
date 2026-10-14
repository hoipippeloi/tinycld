// tinycld/core/server/forms/seed_test.go
package forms

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestSeedDefaults_CreatesOneDefaultPerHostAndBackfills(t *testing.T) {
	e := newTestEnv(t)
	// Inserted before any form exists: the host hook then leaves form empty.
	widgets, _ := e.app.FindCollectionByNameOrId("gizmos_widgets")
	orphan := core.NewRecord(widgets)
	orphan.Set("name", "old")
	if err := e.app.SaveNoValidate(orphan); err != nil {
		t.Fatal(err)
	}
	if err := SeedDefaults(e.app, e.defs); err != nil {
		t.Fatal(err)
	}
	forms, err := e.app.FindRecordsByFilter("forms", "host = {:host}", "", 0, 0, dbx.Params{"host": "gizmos:widget"})
	if err != nil || len(forms) != 1 {
		t.Fatalf("forms = %d err = %v", len(forms), err)
	}
	f := forms[0]
	if !f.GetBool("is_default") || f.GetString("name") != "Widget" || f.GetString("slug") != "widget" {
		t.Fatalf("default form = %v", f.PublicExport())
	}
	def, _ := ParseDefinition([]byte(f.GetString("definition")))
	if len(def.Fields) != 6 || def.Fields[0].Key != "name" || def.Fields[0].Required != true {
		t.Fatalf("definition fields = %+v", def.Fields)
	}
	orphan, _ = e.app.FindRecordById("gizmos_widgets", orphan.Id)
	if orphan.GetString("form") != f.Id {
		t.Fatalf("backfill: form = %q", orphan.GetString("form"))
	}
	if err := SeedDefaults(e.app, e.defs); err != nil {
		t.Fatal(err)
	}
	forms, _ = e.app.FindRecordsByFilter("forms", "host = {:host}", "", 0, 0, dbx.Params{"host": "gizmos:widget"})
	if len(forms) != 1 {
		t.Fatal("seed must be idempotent")
	}
}

func TestSeedDefaults_SkipsAHostWhoseCollectionIsAbsent(t *testing.T) {
	e := newTestEnv(t)
	if err := SeedDefaults(e.app, e.defs); err != nil {
		t.Fatal(err)
	}
	absent, _ := e.app.FindRecordsByFilter("forms", "host = {:host}", "", 0, 0, dbx.Params{"host": "gizmos:other"})
	if len(absent) != 0 {
		t.Fatal("no form for a host whose collection is not installed")
	}
	present, _ := e.app.FindRecordsByFilter("forms", "host = {:host}", "", 0, 0, dbx.Params{"host": "gizmos:widget"})
	if len(present) != 1 {
		t.Fatalf("widget default forms = %d", len(present))
	}
}
