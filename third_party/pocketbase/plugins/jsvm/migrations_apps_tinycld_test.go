package jsvm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// Two apps in one process each load their own JS migrations. A migration
// closes over the runtime of the app that loaded it, so each app must run its
// own migration once and never the other app's.
func TestMigrations_TwoAppsEachRunOnlyTheirOwn(t *testing.T) {
	globalBefore := len(core.AppMigrations.Items())

	apps := map[string]*tests.TestApp{}
	for _, name := range []string{"a", "b"} {
		dir := t.TempDir()
		src := `migrate((app) => { app.save(new Collection({ type: "base", name: "only_` + name + `" })) })`
		if err := os.WriteFile(filepath.Join(dir, "1700000010_only_"+name+".js"), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		app, err := tests.NewTestApp()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(app.Cleanup)
		if err := Register(app, Config{MigrationsDir: dir, HooksDir: filepath.Join(dir, ".no-hooks")}); err != nil {
			t.Fatalf("app %s: Register: %v", name, err)
		}
		apps[name] = app
	}

	for name, app := range apps {
		if err := app.RunAppMigrations(); err != nil {
			t.Fatalf("app %s: RunAppMigrations: %v", name, err)
		}
	}

	for name, app := range apps {
		other := "b"
		if name == "b" {
			other = "a"
		}
		if _, err := app.FindCollectionByNameOrId("only_" + name); err != nil {
			t.Errorf("app %s did not run its own migration: %v", name, err)
		}
		if _, err := app.FindCollectionByNameOrId("only_" + other); err == nil {
			t.Errorf("app %s ran app %s's migration", name, other)
		}
	}
	if got := len(core.AppMigrations.Items()); got != globalBefore {
		t.Errorf("core.AppMigrations went from %d to %d: a JS migration landed in the process-global list", globalBefore, got)
	}
}
