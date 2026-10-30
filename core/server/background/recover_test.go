package background

import (
	"context"
	"strings"
	"testing"
	"time"

	"tinycld.org/core/appstate"
	"tinycld.org/core/readonly/readonlytest"
)

// A panic in one app's goroutine is logged against that app and ends only
// that goroutine: the process, and every other app in it, keeps running.
func TestRecover_LogsWithTheAppAndOtherAppsKeepRunning(t *testing.T) {
	logs := readonlytest.CaptureLogs(t)
	a, b := newTestApp(t), newTestApp(t)

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer Recover(a, "widgets", "widget sweep")
		panic("widget sweep exploded")
	}()
	<-done

	r, ok := readonlytest.Find(logs(), "goroutine panicked")
	if !ok {
		t.Fatal("the panic was not logged")
	}
	if r.Attrs["app"] != appstate.ID(a) || r.Attrs["pkg"] != "widgets" || r.Attrs["job"] != "widget sweep" {
		t.Fatalf("the log must name the app, package and job, got %v", r.Attrs)
	}
	if !strings.Contains(r.Attrs["stack"], "recover_test.go") {
		t.Fatalf("the log must carry the panic's stack, got %q", r.Attrs["stack"])
	}

	ran := make(chan struct{})
	For(b, "widgets").Run("widget check", func(context.Context) { close(ran) })
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("app B's job did not run after app A's goroutine panicked")
	}
}

func TestRun_PanicLogNamesTheApp(t *testing.T) {
	logs := readonlytest.CaptureLogs(t)
	app := newTestApp(t)

	For(app, "widgets").Run("widget notification", func(context.Context) {
		panic("widget exploded")
	})
	app.Cleanup()

	r, ok := readonlytest.Find(logs(), "background job panicked")
	if !ok {
		t.Fatal("the panic was not logged")
	}
	if r.Attrs["app"] != appstate.ID(app) {
		t.Fatalf("the job's panic log must name its app, got %v", r.Attrs)
	}
}
