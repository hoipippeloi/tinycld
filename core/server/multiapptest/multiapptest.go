// Package multiapptest boots several full apps in one test process, each on
// its own data dir, so a test can prove that state set by one app is not seen
// by another.
//
// Each app gets the composition every deployment shares
// (coreserver.RegisterSharedEarly and RegisterSharedCore) with the storage
// ceilings, the download meters and the JS VM in between, in the order
// coreserver.Register uses. Register's own standalone tail is left out: it
// owns process-level effects (restart, signals, the setup installer) that a
// process holding many apps does not run.
//
// Import it only from an external test package (package x_test). It imports
// coreserver, so an in-package test of coreserver, or of any package
// coreserver imports, cannot import it without an import cycle.
package multiapptest

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"

	"tinycld.org/core/coreserver"
	"tinycld.org/core/quota"
	"tinycld.org/core/rlstest"
	"tinycld.org/core/sharequota"
)

// Options adjust what NewAppsWith composes into each app.
type Options struct {
	// MigrationsDirs are package pb_migrations directories applied after
	// core's, as rlstest.AssembledDataDir applies them.
	MigrationsDirs []string

	// RegisterExtras runs for each app where coreserver.Register runs
	// Options.RegisterExtras: after RegisterSharedEarly, before quota and the
	// JS VM. A feature package's two-app test passes its Register here.
	RegisterExtras func(app *pocketbase.PocketBase)

	// DataDir, when set, boots on this existing data dir instead of a fresh
	// assembled copy. It reopens an app that an earlier boot terminated, as an
	// embedder does after closing an idle app. Only valid with n == 1.
	DataDir string
}

// terminatedKey marks an app Terminate already stopped, so the cleanup does
// not run its terminate hooks a second time.
const terminatedKey = "multiapptest.terminated"

// NewApps boots n apps with core's migrations and the shared composition.
// Each app is bootstrapped and terminated when the test ends.
func NewApps(t testing.TB, n int) []*pocketbase.PocketBase {
	t.Helper()
	return NewAppsWith(t, n, Options{})
}

// NewAppsWith is NewApps with package migrations and package registration.
func NewAppsWith(t testing.TB, n int, opts Options) []*pocketbase.PocketBase {
	t.Helper()
	if opts.DataDir != "" && n != 1 {
		t.Fatalf("multiapptest: Options.DataDir needs n == 1, got %d", n)
	}
	apps := make([]*pocketbase.PocketBase, n)
	for i := range apps {
		apps[i] = boot(t, opts)
	}
	return apps
}

func boot(t testing.TB, opts Options) *pocketbase.PocketBase {
	t.Helper()
	dataDir := opts.DataDir
	if dataDir == "" {
		dataDir = rlstest.AssembledDataDir(t, opts.MigrationsDirs...)
	}
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  dataDir,
		HideStartBanner: true,
	})

	coreserver.RegisterSharedEarly(app)
	if opts.RegisterExtras != nil {
		opts.RegisterExtras(app)
	}
	if err := quota.Register(app, quota.RegisteredSources(), quota.SettingsLimits); err != nil {
		t.Fatalf("multiapptest: quota: %v", err)
	}
	sharequota.BindMeters(app)
	// Empty dirs: the data dir is already migrated, and no test hook file
	// may run.
	if err := jsvm.Register(app, jsvm.Config{
		HooksDir:      t.TempDir(),
		MigrationsDir: t.TempDir(),
		HooksPoolSize: 1,
		OnInit:        coreserver.BuildJsvmOnInit(app),
		OnLoaderInit:  coreserver.BuildJsvmOnLoaderInit(app),
	}); err != nil {
		t.Fatalf("multiapptest: jsvm: %v", err)
	}
	coreserver.RegisterSharedCore(app)

	if err := app.Bootstrap(); err != nil {
		t.Fatalf("multiapptest: bootstrap: %v", err)
	}
	t.Cleanup(func() {
		if _, done := app.Store().GetOk(terminatedKey); done {
			return
		}
		terminate(app)
	})
	return app
}

// Serve runs app's OnServe hooks on a fresh router with PocketBase's own
// routes, as apis.Serve does, and returns the router as an http.Handler. Call
// it once per app: OnServe hooks start per-app work (the realtime broker, the
// system settings load) that a second run would start again.
func Serve(t testing.TB, app core.App) http.Handler {
	t.Helper()
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("multiapptest: router: %v", err)
	}
	e := new(core.ServeEvent)
	e.App = app
	e.Router = r
	e.Server = &http.Server{}
	if err := app.OnServe().Trigger(e, func(e *core.ServeEvent) error { return nil }); err != nil {
		t.Fatalf("multiapptest: OnServe: %v", err)
	}
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("multiapptest: build mux: %v", err)
	}
	return mux
}

// Terminate stops app the way a process exit does: its OnTerminate hooks run,
// then its database closes. The other apps keep running.
func Terminate(t testing.TB, app *pocketbase.PocketBase) {
	t.Helper()
	app.Store().Set(terminatedKey, true)
	if err := terminate(app); err != nil {
		t.Fatalf("multiapptest: terminate: %v", err)
	}
}

func terminate(app *pocketbase.PocketBase) error {
	e := new(core.TerminateEvent)
	e.App = app
	return app.OnTerminate().Trigger(e, func(e *core.TerminateEvent) error {
		return e.App.ClearBootstrap()
	})
}
