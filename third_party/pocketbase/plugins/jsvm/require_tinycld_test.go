package jsvm

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// registerRecovered runs Register and turns the panic a failing hook file
// raises into an error the test can report.
func registerRecovered(app core.App, config Config) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return Register(app, config)
}

// Two apps in one process load a hook file that requires "./lib.js". Each
// must get the lib.js in its own hooks dir, not one looked up from the
// process's working directory, which is the same for every app.
func TestRequire_RelativePathResolvesFromTheAppsHooksDir(t *testing.T) {
	for _, name := range []string{"A", "B"} {
		hooksDir := t.TempDir()
		lib := `module.exports = { from: "` + name + `" }`
		if err := os.WriteFile(filepath.Join(hooksDir, "lib.js"), []byte(lib), 0o644); err != nil {
			t.Fatal(err)
		}
		hook := `$app.store().set("libFrom", require("./lib.js").from)`
		if err := os.WriteFile(filepath.Join(hooksDir, "main.pb.js"), []byte(hook), 0o644); err != nil {
			t.Fatal(err)
		}

		app, err := tests.NewTestApp()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(app.Cleanup)

		if err := registerRecovered(app, Config{
			HooksDir:      hooksDir,
			MigrationsDir: t.TempDir(),
			HooksPoolSize: 1,
		}); err != nil {
			t.Fatalf("app %s: Register: %v", name, err)
		}
		if got := app.Store().Get("libFrom"); got != name {
			t.Fatalf("app %s required a lib.js that says %v", name, got)
		}
	}
}
