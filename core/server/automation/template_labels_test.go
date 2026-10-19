package automation

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// A fictional "gizmos" package: things point at tags, which a package-declared
// label names through their family; bins fall back to the display-field
// heuristic; crates have no display field; vaults are superuser-only.
type gizmoFixture struct {
	app     *tests.TestApp
	thing   *core.Record
	tagA    *core.Record
	crate   *core.Record
	vault   *core.Record
	ownerID string
}

var gizmoLabels = map[string]RecordLabelDecl{
	"gizmos_tags": {Format: "{code}-{family.name}", Relations: map[string]string{"family": "gizmos_families"}},
}

func gizmoCollection(t *testing.T, app *tests.TestApp, name string, public bool, fields ...core.Field) *core.Collection {
	t.Helper()
	col := core.NewBaseCollection(name)
	for _, f := range fields {
		col.Fields.Add(f)
	}
	if public {
		col.ViewRule = new(string)
	}
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}
	return col
}

func gizmoRecord(t *testing.T, app *tests.TestApp, col *core.Collection, values map[string]any) *core.Record {
	t.Helper()
	rec := core.NewRecord(col)
	for k, v := range values {
		rec.Set(k, v)
	}
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func newGizmoFixture(t *testing.T) gizmoFixture {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Cleanup() })

	families := gizmoCollection(t, app, "gizmos_families", true, &core.TextField{Name: "name"})
	tags := gizmoCollection(t, app, "gizmos_tags", true,
		&core.TextField{Name: "code"},
		&core.RelationField{Name: "family", CollectionId: families.Id, MaxSelect: 1},
	)
	bins := gizmoCollection(t, app, "gizmos_bins", true, &core.TextField{Name: "title"})
	crates := gizmoCollection(t, app, "gizmos_crates", true, &core.NumberField{Name: "weight"})
	vaults := gizmoCollection(t, app, "gizmos_vaults", false, &core.TextField{Name: "name"})
	things := gizmoCollection(t, app, "gizmos_things", true,
		&core.TextField{Name: "subject"},
		&core.RelationField{Name: "tag", CollectionId: tags.Id, MaxSelect: 1},
		&core.RelationField{Name: "tags", CollectionId: tags.Id, MaxSelect: 5},
		&core.RelationField{Name: "bin", CollectionId: bins.Id, MaxSelect: 1},
		&core.RelationField{Name: "crate", CollectionId: crates.Id, MaxSelect: 1},
		&core.RelationField{Name: "vault", CollectionId: vaults.Id, MaxSelect: 1},
	)

	widgets := gizmoRecord(t, app, families, map[string]any{"name": "Widgets"})
	gadgets := gizmoRecord(t, app, families, map[string]any{"name": "Gadgets"})
	tagA := gizmoRecord(t, app, tags, map[string]any{"code": "T1", "family": widgets.Id})
	tagB := gizmoRecord(t, app, tags, map[string]any{"code": "T2", "family": gadgets.Id})
	bin := gizmoRecord(t, app, bins, map[string]any{"title": "Top shelf"})
	crate := gizmoRecord(t, app, crates, map[string]any{"weight": 12})
	vault := gizmoRecord(t, app, vaults, map[string]any{"name": "Secret vault"})
	thing := gizmoRecord(t, app, things, map[string]any{
		"subject": "Restock",
		"tag":     tagA.Id,
		"tags":    []string{tagA.Id, tagB.Id},
		"bin":     bin.Id,
		"crate":   crate.Id,
		"vault":   vault.Id,
	})

	owner, err := app.FindFirstRecordByFilter("users", "id != ''")
	if err != nil {
		t.Fatal(err)
	}
	return gizmoFixture{app: app, thing: thing, tagA: tagA, crate: crate, vault: vault, ownerID: owner.Id}
}

func TestRelationPlaceholdersRenderRecordNames(t *testing.T) {
	f := newGizmoFixture(t)
	env := TemplateEnv{App: f.app, Labels: gizmoLabels, OwnerID: f.ownerID}

	cases := []struct{ name, in, want string }{
		{"declared label reads through its relation", "Tag {{tag}}", "Tag T1-Widgets"},
		{"multi relation names every record", "{{tags}}", "T1-Widgets, T2-Gadgets"},
		{"undeclared target uses the display field", "In {{bin}}", "In Top shelf"},
		{"target with no display field renders the id", "{{crate}}", f.crate.Id},
		{"record the owner may not view renders the id", "{{vault}}", f.vault.Id},
		{"plain fields are unchanged", "{{subject}}", "Restock"},
	}
	for _, tc := range cases {
		if got := SubstituteTemplates(tc.in, f.thing, TriggerDef{}, env); got != tc.want {
			t.Errorf("%s: %q rendered %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

func TestRelationPlaceholderWithoutOwnerRendersID(t *testing.T) {
	f := newGizmoFixture(t)
	env := TemplateEnv{App: f.app, Labels: gizmoLabels}
	if got := SubstituteTemplates("{{tag}}", f.thing, TriggerDef{}, env); got != f.tagA.Id {
		t.Fatalf("no owner to check access as must render the id, got %q", got)
	}
}

func TestDeclaredLabelWithNoValuesRendersID(t *testing.T) {
	f := newGizmoFixture(t)
	f.tagA.Set("code", "")
	f.tagA.Set("family", "")
	if err := f.app.Save(f.tagA); err != nil {
		t.Fatal(err)
	}
	env := TemplateEnv{App: f.app, Labels: gizmoLabels, OwnerID: f.ownerID}
	if got := SubstituteTemplates("{{tag}}", f.thing, TriggerDef{}, env); got != f.tagA.Id {
		t.Fatalf("a label with every placeholder empty must render the id, got %q", got)
	}
}
