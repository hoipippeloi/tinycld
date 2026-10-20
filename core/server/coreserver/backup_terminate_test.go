package coreserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/background"
	"tinycld.org/core/backup"
	"tinycld.org/core/backup/format"
	"tinycld.org/core/backup/repo"
	"tinycld.org/core/backup/snapshot"
	"tinycld.org/core/installjob"
	"tinycld.org/core/shutdown"
)

// heldRepo is a repository whose Put reports that it started and then, when
// hold is set, waits for its context as a client whose server went silent does.
type heldRepo struct {
	hold    bool
	entered chan struct{}
}

func newHeldRepo(hold bool) *heldRepo {
	return &heldRepo{hold: hold, entered: make(chan struct{}, 1)}
}

func (r *heldRepo) Kind() string { return "held" }
func (r *heldRepo) Put(ctx context.Context, _ *snapshot.Snapshot, _ func(int64)) (repo.PutResult, error) {
	r.entered <- struct{}{}
	if !r.hold {
		return repo.PutResult{Ref: "held/1"}, nil
	}
	<-ctx.Done()
	return repo.PutResult{}, ctx.Err()
}
func (r *heldRepo) Manifest(context.Context, repo.Ref) (format.Manifest, error) {
	return format.Manifest{}, nil
}
func (r *heldRepo) Fetch(context.Context, repo.Ref, string) error     { return nil }
func (r *heldRepo) List(context.Context) ([]repo.SnapshotInfo, error) { return nil, nil }

// stuckCallback is a callback receiver that takes the POST and never answers.
// It lets go only when the client gives up on the request, or when the test
// ends, so a run that never cancels its callback is still unblocked for cleanup.
func stuckCallback(t *testing.T) (url string, hit <-chan struct{}) {
	t.Helper()
	got := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case got <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(srv.Close)
	// Registered after srv.Close, so it runs first: Close waits for the handler.
	t.Cleanup(func() { close(release) })
	return srv.URL, got
}

// terminateSnapshot is what the app looked like at the instant every hook before
// the finalizer had run: the moment PocketBase is about to close the database.
type terminateSnapshot struct {
	status      string
	interlocked bool
}

// terminate runs the app's OnTerminate chain the way PocketBase does on SIGTERM,
// finalizer included, and reports the state just before the finalizer. The
// finalizer itself looks, so it sees the state after every hook the
// composition bound, whatever their priorities.
func terminate(t *testing.T, app core.App, rowID string) terminateSnapshot {
	t.Helper()
	var seen terminateSnapshot
	done := make(chan error, 1)
	go func() {
		done <- app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
			if row, err := e.App.FindRecordById("backups", rowID); err == nil {
				seen.status = row.GetString("status")
			}
			seen.interlocked = installjob.Running()
			return e.App.ResetBootstrapState()
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("terminate: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the terminate hooks never returned")
	}
	return seen
}

// terminateApp is the backup app with the boot wiring bound and booted through
// it, so the runs' lifetime is armed the way a real boot arms it.
func terminateApp(t *testing.T) core.App {
	t.Helper()
	app := backupTestApp(t)
	RegisterBackupBoot(app)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	return app
}

// A stop during a backup must not close the database under the run: the run
// still writes its ledger row, notifies administrators and posts its callback.
// Before the fix the hook cancelled the run and returned at once, so all of that
// landed on a closed app and could crash the process on its way out.
func TestTerminateWaitsForABackupInItsRepository(t *testing.T) {
	app := terminateApp(t)
	r := newHeldRepo(true)
	cb, _ := stuckCallback(t)

	id, err := backup.Start(app, backup.Request{Kind: backup.KindManual, Repo: r, TargetHost: r.Kind(), Callback: cb})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-r.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the run never reached its repository")
	}

	seen := terminate(t, app, id)
	if seen.status != "failed" {
		t.Errorf("the row was %q when the database closed; the run's terminal write had not landed", seen.status)
	}
	if seen.interlocked {
		t.Error("the run still held the interlock when the database closed")
	}
}

// A run whose archive is written and whose callback receiver never answers is
// past every transfer the shutdown used to cancel. The stop must reach the
// callback too, or the hook either returns under a live run or waits on a peer.
func TestTerminateCancelsACallbackInFlight(t *testing.T) {
	app := terminateApp(t)
	r := newHeldRepo(false)
	cb, hit := stuckCallback(t)

	id, err := backup.Start(app, backup.Request{Kind: backup.KindManual, Repo: r, TargetHost: r.Kind(), Callback: cb})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the run never posted its callback")
	}

	seen := terminate(t, app, id)
	if seen.status != "succeeded" {
		t.Errorf("the row was %q, want succeeded", seen.status)
	}
	if seen.interlocked {
		t.Error("the run was still in its callback when the database closed")
	}
}

// liveRepo's Put fails when its context is already done, as any client does
// when handed a cancelled request. A run that inherits a cancelled shutdown
// context therefore fails here instead of passing by ignoring it.
type liveRepo struct{ heldRepo }

func (r *liveRepo) Put(ctx context.Context, _ *snapshot.Snapshot, _ func(int64)) (repo.PutResult, error) {
	if err := ctx.Err(); err != nil {
		return repo.PutResult{}, err
	}
	return repo.PutResult{Ref: "live/1"}, nil
}

// failedRestart is what PocketBase's app.Restart does when execve fails: the
// terminate hooks run with IsRestart, the finalizer closes the app, and a
// deferred Bootstrap brings it back in the same process.
func failedRestart(t *testing.T, app core.App) {
	t.Helper()
	execFailed := errors.New("exec format error")
	err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app, IsRestart: true}, func(e *core.TerminateEvent) error {
		_ = e.App.ClearBootstrap()
		defer func() {
			if err := e.App.Bootstrap(); err != nil {
				t.Errorf("re-bootstrap after the failed restart: %v", err)
			}
		}()
		return execFailed
	})
	if !errors.Is(err, execFailed) {
		t.Fatalf("restart = %v, want the exec failure", err)
	}
}

// runLiveBackup runs a backup whose repository checks its context, and fails
// the test unless it succeeds.
func runLiveBackup(t *testing.T, app core.App, when string) {
	t.Helper()
	id, err := backup.Run(app, backup.Request{Kind: backup.KindScheduled, Repo: &liveRepo{}, TargetHost: "live"})
	if err != nil {
		t.Fatalf("a backup %s failed: %v", when, err)
	}
	row, err := app.FindRecordById("backups", id)
	if err != nil {
		t.Fatal(err)
	}
	if got := row.GetString("status"); got != "succeeded" {
		t.Fatalf("a backup %s finished %q", when, got)
	}
}

// A restart whose execve fails leaves this process running on a re-bootstrapped
// app. The stop the restart began must not outlive it: backups must neither be
// refused as stopping nor start on the cancelled shutdown context.
func TestAFailedRestartLeavesBackupsRunnable(t *testing.T) {
	app := terminateApp(t)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}, func(*core.ServeEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	runLiveBackup(t, app, "before the restart")

	failedRestart(t, app)

	runLiveBackup(t, app, "after a failed restart")
}

// stuckRepo is a repository whose Put ignores its context, as a VACUUM INTO
// does: cancellation cannot reach it. It returns only when the test ends.
type stuckRepo struct {
	entered chan struct{}
	release <-chan struct{}
}

func (r *stuckRepo) Kind() string { return "stuck" }
func (r *stuckRepo) Put(context.Context, *snapshot.Snapshot, func(int64)) (repo.PutResult, error) {
	r.entered <- struct{}{}
	<-r.release
	return repo.PutResult{}, errors.New("released at the end of the test")
}
func (r *stuckRepo) Manifest(context.Context, repo.Ref) (format.Manifest, error) {
	return format.Manifest{}, nil
}
func (r *stuckRepo) Fetch(context.Context, repo.Ref, string) error     { return nil }
func (r *stuckRepo) List(context.Context) ([]repo.SnapshotInfo, error) { return nil, nil }

// A backup run that cancellation cannot reach is the cheapest wait to cut: the
// next boot closes its row. It must not use the terminate's shared deadline
// before a background job that is finishing a write. The backup stop is bound
// first ("widgets" binds its runner after the boot wiring), so at the default
// priority it waited out the whole deadline and the database closed under the
// job; after the default-priority handlers, the job finishes and the backup
// wait gets what is left.
func TestTerminate_BackupRunWaitsAfterTheBackgroundJobs(t *testing.T) {
	const budget = 800 * time.Millisecond
	app := terminateApp(t)
	shutdown.SetKillAfter(app, func() time.Duration { return shutdown.FinalizerMargin + budget })

	release, releaseAll := releaser()
	t.Cleanup(releaseAll)
	stuck := &stuckRepo{entered: make(chan struct{}, 1), release: release}
	if _, err := backup.Start(app, backup.Request{Kind: backup.KindManual, Repo: stuck, TargetHost: stuck.Kind()}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stuck.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the run never reached its repository")
	}

	// The job's last write takes a moment after the cancel, as a save in
	// flight does.
	var finished atomic.Bool
	background.For(app, "widgets").Run("widget index", func(ctx context.Context) {
		<-ctx.Done()
		time.Sleep(200 * time.Millisecond)
		finished.Store(true)
	})

	var finishedAtClose bool
	begun := time.Now()
	err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
		finishedAtClose = finished.Load()
		return e.App.ResetBootstrapState()
	})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if took := time.Since(begun); took >= budget+time.Second {
		t.Fatalf("the terminate took %v; its waits did not share the %v deadline", took, budget)
	}
	if !finishedAtClose {
		t.Fatal("the database closed under a background job: the backup wait used the deadline before it")
	}
}
