package background

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/readonly/readonlytest"
)

// "widgets" and "gadgets" are fictional packages: core names none of its own.

func newTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestFor_OneRunnerPerAppAndPackage(t *testing.T) {
	app := newTestApp(t)
	other := newTestApp(t)

	before := app.OnTerminate().Length()
	widgets := For(app, "widgets")
	if For(app, "widgets") != widgets {
		t.Fatal("a second For for the same app and package returned a new runner")
	}
	if app.OnTerminate().Length() != before+1 {
		t.Fatalf("want one terminate handler for the package, got %d new",
			app.OnTerminate().Length()-before)
	}
	if For(app, "gadgets") == widgets {
		t.Fatal("two packages share one runner")
	}
	if For(other, "widgets") == widgets {
		t.Fatal("two apps share one runner")
	}
}

// A panic in a job is logged through the package's logger, with its stack,
// and does not end the process.
func TestRun_RecoversAndLogsPanic(t *testing.T) {
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
	if r.Level != slog.LevelError {
		t.Fatalf("want Error for a panic, got %v", r.Level)
	}
	if r.Attrs["pkg"] != "widgets" || r.Attrs["job"] != "widget notification" {
		t.Fatalf("the log must name the package and the job, got %v", r.Attrs)
	}
	if !strings.Contains(r.Attrs["stack"], "background_test.go") {
		t.Fatalf("the log must carry the panic's stack, got %q", r.Attrs["stack"])
	}
}

// The terminate must hold until a running job finishes, so the job still has
// an open database. The job's ctx ends first, which tells it to stop.
func TestTerminate_WaitsForRunningJob(t *testing.T) {
	app := newTestApp(t)

	started := make(chan struct{})
	sawCancel := make(chan struct{})
	release := make(chan struct{})
	dbOpenAtEnd := false
	For(app, "widgets").Run("blocking", func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(sawCancel)
		<-release
		dbOpenAtEnd = app.ConcurrentDB() != nil
	})
	<-started

	cleaned := make(chan struct{})
	go func() {
		app.Cleanup()
		close(cleaned)
	}()

	select {
	case <-sawCancel:
	case <-time.After(10 * time.Second):
		t.Fatal("the terminate did not cancel the job's context")
	}
	select {
	case <-cleaned:
		t.Fatal("the terminate finished while a job was still running")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-cleaned:
	case <-time.After(10 * time.Second):
		t.Fatal("the terminate did not finish after the job returned")
	}
	if !dbOpenAtEnd {
		t.Fatal("the database closed before the job finished")
	}
}

// Each package binds its own terminate handler; the terminate waits for the
// jobs of every one of them.
func TestTerminate_WaitsForEveryPackage(t *testing.T) {
	app := newTestApp(t)

	finished := map[string]bool{}
	results := make(chan string, 2)
	for _, pkg := range []string{"widgets", "gadgets"} {
		For(app, pkg).Run(pkg+" sweep", func(ctx context.Context) {
			<-ctx.Done()
			time.Sleep(20 * time.Millisecond)
			results <- pkg
		})
	}
	app.Cleanup()
	close(results)
	for pkg := range results {
		finished[pkg] = true
	}
	if !finished["widgets"] || !finished["gadgets"] {
		t.Fatalf("the terminate returned before every package's job finished: %v", finished)
	}
}

// A job handed over after the terminate began would run against a closing
// database, so it is dropped and logged. For still returns the stopped
// runner, so a lookup after the terminate cannot start a fresh one.
func TestRun_DropsJobAfterTerminate(t *testing.T) {
	logs := readonlytest.CaptureLogs(t)
	app := newTestApp(t)
	For(app, "widgets")
	app.Cleanup()

	ran := make(chan struct{}, 1)
	started := For(app, "widgets").Run("late", func(context.Context) { ran <- struct{}{} })

	if started {
		t.Fatal("Run reported a job started after the terminate")
	}
	select {
	case <-ran:
		t.Fatal("a job started after the terminate")
	case <-time.After(20 * time.Millisecond):
	}
	r, ok := readonlytest.Find(logs(), "background job dropped: the app is terminating")
	if !ok {
		t.Fatal("the dropped job was not logged")
	}
	if r.Level != slog.LevelWarn || r.Attrs["job"] != "late" || r.Attrs["pkg"] != "widgets" {
		t.Fatalf("want a Warn naming the package and the job, got %v %v", r.Level, r.Attrs)
	}
}

// A terminate held up by a job that ignores its ctx names that job, so an
// operator can see what blocks the shutdown.
func TestTerminate_LogsStalledJobs(t *testing.T) {
	prev := stallWarnInterval
	stallWarnInterval = 10 * time.Millisecond
	t.Cleanup(func() { stallWarnInterval = prev })
	logs := readonlytest.CaptureLogs(t)
	app := newTestApp(t)

	release := make(chan struct{})
	For(app, "widgets").Run("stuck widget send", func(context.Context) { <-release })

	cleaned := make(chan struct{})
	go func() {
		app.Cleanup()
		close(cleaned)
	}()

	deadline := time.After(10 * time.Second)
	for {
		if r, ok := readonlytest.Find(logs(), "terminate is waiting for background jobs that have not stopped"); ok {
			if !strings.Contains(r.Attrs["jobs"], "stuck widget send") {
				t.Fatalf("the stall log must name the job, got %v", r.Attrs)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("no stall log while the terminate waited")
		case <-time.After(5 * time.Millisecond):
		}
	}

	close(release)
	<-cleaned
}
