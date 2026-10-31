package coreserver

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Two apps in one process each load their own JS migrations. A package
// install or uninstall on one app resolves only the files that app loaded.
func TestPkgMigrationByFile_ResolvesOnlyTheAppsOwnJSMigrations(t *testing.T) {
	appA, appB := newMigrateTestApp(t), newMigrateTestApp(t)

	const file = "9700000020_only_a.js"
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(`migrate((app) => {}, (app) => {})`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := jsvm.Register(appA, jsvm.Config{MigrationsDir: dir, HooksDir: filepath.Join(dir, ".no-hooks")}); err != nil {
		t.Fatal(err)
	}

	if _, ok := pkgMigrationByFile(appA, file); !ok {
		t.Fatal("app A does not resolve the JS migration it loaded")
	}
	if _, ok := pkgMigrationByFile(appB, file); ok {
		t.Fatal("app B resolves a JS migration only app A loaded")
	}
	if got := RegisteredOnly(appB, []string{file}); len(got) != 0 {
		t.Fatalf("RegisteredOnly(appB) = %v, want none", got)
	}
}
