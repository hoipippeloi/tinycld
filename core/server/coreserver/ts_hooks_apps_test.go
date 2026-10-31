package coreserver

import (
	"testing"

	"github.com/grafana/sobek"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// newHookTestApp returns an app that is never bootstrapped: the hook registry
// lives in app.Store(), which needs no database.
func newHookTestApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	return pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  t.TempDir(),
		HideStartBanner: true,
	})
}

// Two apps in one process each load their own hook files. App A's handler was
// compiled on A's loader VM and runs on A's executor pool with A's $app, so
// app B's hook points must never reach it.
func TestWebDAVHookPointsArePerApp(t *testing.T) {
	_, hooksA := bootHooksApp(t, `
        webdavHook({ beforeWrite(e) { throw new Error("blocked by app A") } })
    `)
	_, hooksB := bootHooksApp(t, "")

	if !hooksA.BeforeWrite.Enabled() {
		t.Fatal("app A's beforeWrite must carry the handler app A's TS registered")
	}
	if hooksB.BeforeWrite.Enabled() {
		t.Fatal("app B's beforeWrite reaches the handler app A's TS registered")
	}
	if _, handled, err := hooksB.BeforeWrite.Call(map[string]any{"name": "report.pdf"}); err != nil || handled {
		t.Fatalf("app B ran app A's handler: handled=%v err=%v", handled, err)
	}
}

func TestRegisterHookPointIsPerApp(t *testing.T) {
	a, b := newHookTestApp(t), newHookTestApp(t)

	pointA := RegisterHookPoint(a, "test.same")
	pointB := RegisterHookPoint(b, "test.same")
	if pointA == pointB {
		t.Fatal("two apps must not share a hook point")
	}
	pointA.Add(func(_ ...any) (any, error) { return "a", nil })
	if pointB.Enabled() {
		t.Fatal("a handler added on app A's point enabled app B's point")
	}
	if RegisterHookPoint(a, "test.same") != pointA {
		t.Fatal("a second RegisterHookPoint on the same app must return the same point")
	}
	if LookupHookPoint(b, "test.same") != pointB {
		t.Fatal("LookupHookPoint must return the app's own point")
	}
}

func TestLoaderBindersArePerApp(t *testing.T) {
	a, b := newHookTestApp(t), newHookTestApp(t)

	var ranFor []string
	RegisterLoaderBinder(a, func(_ *sobek.Runtime, _ jsvm.Compiler, app *pocketbase.PocketBase) error {
		ranFor = append(ranFor, app.DataDir())
		return nil
	})

	BuildJsvmOnLoaderInit(b)(sobek.New(), nil)
	if len(ranFor) != 0 {
		t.Fatalf("app B's loader ran a binder registered on app A (ran for %v)", ranFor)
	}
	BuildJsvmOnLoaderInit(a)(sobek.New(), nil)
	if len(ranFor) != 1 || ranFor[0] != a.DataDir() {
		t.Fatalf("app A's loader ran its binder for %v, want once for %s", ranFor, a.DataDir())
	}
}

// Every app in the process runs the same Register, so one package registers
// its binder once per app. The VM must still get the namespace once.
func TestRegisterJSVMBinder_SameNameRegistersOnce(t *testing.T) {
	resetBinders(t)

	var calls int
	binder := func(_ *sobek.Runtime, _ *pocketbase.PocketBase) error {
		calls++
		return nil
	}
	RegisterJSVMBinder("probe", binder)
	RegisterJSVMBinder("probe", binder)

	BuildJsvmOnInit(nil)(sobek.New())
	if calls != 1 {
		t.Fatalf("binder ran %d times on one VM; want 1", calls)
	}
}
