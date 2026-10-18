package fts

import (
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func newSyncTestApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir(), HideStartBanner: true})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })

	items := core.NewBaseCollection("sync_items")
	items.Fields.Add(&core.TextField{Name: "title"})
	if err := app.Save(items); err != nil {
		t.Fatalf("save collection: %v", err)
	}
	if _, err := app.NonconcurrentDB().NewQuery(
		"CREATE VIRTUAL TABLE fts_sync_items USING fts5(record_id UNINDEXED, title, extra)",
	).Execute(); err != nil {
		t.Fatalf("create fts table: %v", err)
	}
	return app
}

func createSyncItem(t *testing.T, app *pocketbase.PocketBase, title string) *core.Record {
	t.Helper()
	c, err := app.FindCollectionByNameOrId("sync_items")
	if err != nil {
		t.Fatalf("find collection: %v", err)
	}
	rec := core.NewRecord(c)
	rec.Set("title", title)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save record: %v", err)
	}
	return rec
}

func ftsColumn(t *testing.T, app *pocketbase.PocketBase, table, id, col string) string {
	t.Helper()
	var out struct {
		Val string `db:"val"`
	}
	err := app.DB().NewQuery("SELECT " + col + " AS val FROM " + table + " WHERE record_id = {:id}").
		Bind(map[string]any{"id": id}).One(&out)
	if err != nil {
		t.Fatalf("read %s.%s: %v", table, col, err)
	}
	return out.Val
}

func TestSyncRecord_UsesTextWhenSet(t *testing.T) {
	app := newSyncTestApp(t)
	cfg := Config{
		Collection: "sync_items",
		Table:      "fts_sync_items",
		Columns: []Column{
			{FTS: "title", Field: "title"},
			{FTS: "extra", Text: func(r *core.Record) string { return "from " + r.GetString("title") }},
		},
	}
	rec := createSyncItem(t, app, "T")
	syncRecord(app, cfg, rec, false)

	if got := ftsColumn(t, app, cfg.Table, rec.Id, "extra"); got != "from T" {
		t.Fatalf("extra = %q", got)
	}
	if got := ftsColumn(t, app, cfg.Table, rec.Id, "title"); got != "T" {
		t.Fatalf("title = %q", got)
	}
}
