package coreserver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/hook"

	"tinycld.org/core/background"
	"tinycld.org/core/installjob"
)

// runTerminate runs app's terminate chain the way PocketBase's own terminate
// does: every handler, then the finalizer that closes the database.
func runTerminate(app core.App) {
	event := new(core.TerminateEvent)
	event.App = app
	_ = app.OnTerminate().Trigger(event, func(e *core.TerminateEvent) error {
		return e.App.ResetBootstrapState()
	})
}

// claimTestJob claims app's interlock for a new job; the rebuild
// runner releases it when the job returns.
func claimTestJob(t *testing.T, app core.App, action, slug string) *installjob.Job {
	t.Helper()
	job := installjob.New(action, slug, "")
	if busy, ok := installjob.Claim(app, job); !ok {
		t.Fatalf("interlock already held by %+v", busy.Info())
	}
	t.Cleanup(func() { installjob.Release(job) })
	return job
}

type logSave struct{ status, errMsg string }

// installLogSaves records every pkg_install_log save that reached the
// database.
func installLogSaves(app core.App) func() []logSave {
	var mu sync.Mutex
	var saves []logSave
	app.OnRecordAfterUpdateSuccess("pkg_install_log").BindFunc(func(e *core.RecordEvent) error {
		mu.Lock()
		saves = append(saves, logSave{e.Record.GetString("status"), e.Record.GetString("error")})
		mu.Unlock()
		return e.Next()
	})
	return func() []logSave {
		mu.Lock()
		defer mu.Unlock()
		return append([]logSave(nil), saves...)
	}
}

func lastSave(t *testing.T, saves []logSave) logSave {
	t.Helper()
	if len(saves) == 0 {
		t.Fatal("the install log row was never saved")
	}
	return saves[len(saves)-1]
}

func awaitDone(t *testing.T, job *installjob.Job, within time.Duration) {
	t.Helper()
	select {
	case <-job.Done:
	case <-time.After(within):
		t.Fatalf("job %s did not end within %s", job.ID, within)
	}
}

// fakeBuildTool puts a `name` first on PATH that starts a child of its own,
// which appends a line to the returned heartbeat file every 50 ms, and waits
// for it. A kill that reaches only the tool leaves the child writing.
func fakeBuildTool(t *testing.T, name string) (heartbeat string) {
	t.Helper()
	dir := t.TempDir()
	heartbeat = filepath.Join(dir, "heartbeat")
	script := "#!/bin/sh\n(while true; do echo beat >> \"$FAKE_BUILD_HEARTBEAT\"; sleep 0.05; done) &\nwait\n"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_BUILD_HEARTBEAT", heartbeat)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return heartbeat
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func awaitHeartbeat(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for fileSize(path) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the fake build tool never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A job in its build step: the terminate kills the build command and the
// processes it started, and returns as soon as the job has recorded its
// failure, well inside the bound. The pipeline is the production one, so
// this also proves the run's ctx reaches the build's own exec.
func TestRebuildJobs_TerminateKillsTheBuildCommand(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	app := bootstrappedApp(t)
	addInstallLogCollection(t, app)
	saves := installLogSaves(app)
	heartbeat := fakeBuildTool(t, "pnpm")
	job := claimTestJob(t, app, "install", "widgets")
	m := RebuildManifest{BuildID: "build-7", Members: []MemberSpec{{Slug: "tinycld", Spec: "x"}}}

	var tailStarted atomic.Bool
	err := rebuildJobsFor(app).start(app, job, func(run *jobRun) {
		logRecord := run.createLog("install")
		deps := productionRebuildDeps(run, app, job, m, logRecord)
		deps.assemble = func(_ RebuildManifest, dir string) error { return os.MkdirAll(dir, 0o755) }
		deps.verifyCompat = nil
		deps.prepareTools = nil
		deps.tagLog = func(string) error { tailStarted.Store(true); return nil }
		deps.backupDB = func() error { tailStarted.Store(true); return nil }
		_ = rebuildWith(job, m, deps)
	})
	mustNil(t, err)
	awaitHeartbeat(t, heartbeat)

	start := time.Now()
	runTerminate(app)
	if took := time.Since(start); took >= rebuildCancelGrace {
		t.Fatalf("terminate took %s: it waited out the grace instead of the job ending at the cancel", took)
	}
	awaitDone(t, job, time.Second)

	// The tool's own child stops writing too: the kill reached the group.
	time.Sleep(200 * time.Millisecond)
	before := fileSize(heartbeat)
	time.Sleep(300 * time.Millisecond)
	if after := fileSize(heartbeat); after != before {
		t.Fatalf("the build tool's child still runs after the terminate (heartbeat %d -> %d bytes)", before, after)
	}
	if tailStarted.Load() {
		t.Fatal("a cancelled build went on into the database tail")
	}
	got := lastSave(t, saves())
	if got.status != "failed" || !strings.Contains(got.errMsg, errRebuildCancelled.Error()) {
		t.Fatalf("last install log save = %+v, want failed with %q", got, errRebuildCancelled)
	}
	if installjob.Running(app) {
		t.Fatal("the interlock is still held after the job ended")
	}
}

// A job stopped between two steps records the failure on its row before
// the database closes, and starts nothing of the tail.
func TestRebuildJobs_CancelledJobFinalizesItsLogRow(t *testing.T) {
	state := t.TempDir()
	t.Setenv("TINYCLD_STATE_DIR", state)
	app := bootstrappedApp(t)
	addInstallLogCollection(t, app)
	saves := installLogSaves(app)
	job := claimTestJob(t, app, "install", "widgets")
	m := RebuildManifest{BuildID: "build-8", Members: []MemberSpec{{Slug: "tinycld", Spec: "x"}}}

	inAssemble := make(chan struct{})
	release, letGo := releaser()
	t.Cleanup(letGo)
	var piped, backedUp atomic.Bool
	mustNil(t, rebuildJobsFor(app).start(app, job, func(run *jobRun) {
		logRecord := run.createLog("install")
		var restored, restarted bool
		deps := happyDeps(&restored, &restarted)
		deps.run = run
		deps.assemble = func(_ RebuildManifest, dir string) error {
			close(inAssemble)
			<-release
			return os.MkdirAll(dir, 0o755)
		}
		deps.pipeline = func(*installjob.Job, string) (buildOutput, error) { piped.Store(true); return buildOutput{}, nil }
		deps.backupDB = func() error { backedUp.Store(true); return nil }
		deps.finalizeLog = func(status, errMsg string) {
			finalizeInstallLog(app, logRecord, status, errMsg, job.LogLines)
		}
		_ = rebuildWith(job, m, deps)
	}))
	<-inAssemble

	terminated := make(chan struct{})
	go func() {
		runTerminate(app)
		close(terminated)
	}()
	time.Sleep(100 * time.Millisecond)
	letGo()
	awaitTerminated(t, terminated, "cancelled rebuild")
	awaitDone(t, job, time.Second)

	if piped.Load() || backedUp.Load() {
		t.Fatalf("the job went on after the cancel (pipeline=%v backup=%v)", piped.Load(), backedUp.Load())
	}
	got := lastSave(t, saves())
	if got.status != "failed" || !strings.Contains(got.errMsg, errRebuildCancelled.Error()) {
		t.Fatalf("last install log save = %+v, want failed with %q", got, errRebuildCancelled)
	}
	if _, err := os.Stat(filepath.Join(state, "builds", "build-8")); !os.IsNotExist(err) {
		t.Fatalf("the cancelled build dir was kept (stat err %v)", err)
	}
}

// A job in its database tail when the terminate comes finishes the tail
// before the database closes: the row records success. The grace for a
// building job is cut below the hold, so only the tail's own bound lets the
// terminate wait that long.
func TestRebuildJobs_TerminateLetsTheTailFinish(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	prevGrace := rebuildCancelGrace
	rebuildCancelGrace = 50 * time.Millisecond
	t.Cleanup(func() { rebuildCancelGrace = prevGrace })
	app := bootstrappedApp(t)
	addInstallLogCollection(t, app)
	saves := installLogSaves(app)
	job := claimTestJob(t, app, "install", "widgets")
	m := RebuildManifest{BuildID: "build-9", Members: []MemberSpec{{Slug: "tinycld", Spec: "x"}}}

	inSync := make(chan struct{})
	release, letGo := releaser()
	t.Cleanup(letGo)
	var activated, pruned, restarted atomic.Bool
	mustNil(t, rebuildJobsFor(app).start(app, job, func(run *jobRun) {
		logRecord := run.createLog("install")
		var restored, restartedFlag bool
		deps := happyDeps(&restored, &restartedFlag)
		deps.run = run
		deps.syncMig = func(string) (SyncResult, error) {
			close(inSync)
			<-release
			return SyncResult{}, nil
		}
		deps.activate = func(string) error { activated.Store(true); return nil }
		deps.prune = func(int) error { pruned.Store(true); return nil }
		deps.restart = func() { restarted.Store(true) }
		deps.finalizeLog = func(status, errMsg string) {
			finalizeInstallLog(app, logRecord, status, errMsg, job.LogLines)
		}
		_ = rebuildWith(job, m, deps)
	}))
	<-inSync

	terminated := make(chan struct{})
	go func() {
		runTerminate(app)
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatal("terminate returned while the job was in its database tail")
	case <-time.After(500 * time.Millisecond):
	}
	letGo()
	awaitTerminated(t, terminated, "rebuild tail")

	select {
	case <-job.Done:
	default:
		t.Fatal("terminate returned before the job ended")
	}
	if !activated.Load() || !restarted.Load() {
		t.Fatalf("the tail did not finish (activate=%v restart=%v)", activated.Load(), restarted.Load())
	}
	if pruned.Load() {
		t.Fatal("a terminating job pruned old builds")
	}
	if got := lastSave(t, saves()); got.status != "success" {
		t.Fatalf("last install log save = %+v, want success", got)
	}
}

// A panic in a job is recovered: the row and the job record the failure,
// and the interlock is released.
func TestRebuildJobs_PanicIsRecoveredAndFinalized(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	app := bootstrappedApp(t)
	addInstallLogCollection(t, app)
	saves := installLogSaves(app)
	job := claimTestJob(t, app, "install", "widgets")

	mustNil(t, rebuildJobsFor(app).start(app, job, func(run *jobRun) {
		run.createLog("install")
		panic("widget exploded")
	}))
	awaitDone(t, job, 10*time.Second)

	got := lastSave(t, saves())
	if got.status != "failed" || !strings.Contains(got.errMsg, "widget exploded") {
		t.Fatalf("last install log save = %+v, want failed with the panic", got)
	}
	if job.Status != "failed" {
		t.Fatalf("job status = %q, want failed", job.Status)
	}
	if installjob.Running(app) {
		t.Fatal("the interlock is still held after the panicked job")
	}
}

// A restart the veto refuses runs no other terminate handler: the HTTP
// server's graceful shutdown (PocketBase, -9999), the realtime stop
// (-10001), the supervised drain (-10000), the mail protocol drain (-1) and every
// default-priority handler keep running. A terminate that is not a vetoed
// restart runs them all.
func TestRebuildJobs_VetoedRestartRunsNoOtherTerminateHandler(t *testing.T) {
	app := bootstrappedApp(t)
	rebuildJobsFor(app)
	var ran []int
	var mu sync.Mutex
	for _, p := range []int{-10001, -10000, -9999, -1, 0} {
		app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
			Priority: p,
			Func: func(e *core.TerminateEvent) error {
				mu.Lock()
				ran = append(ran, p)
				mu.Unlock()
				return e.Next()
			},
		})
	}
	job := claimTestJob(t, app, "install", "widgets")

	restart := new(core.TerminateEvent)
	restart.App = app
	restart.IsRestart = true
	mustNil(t, app.OnTerminate().Trigger(restart))
	if len(ran) != 0 {
		t.Fatalf("a vetoed restart ran the terminate handlers at priorities %v", ran)
	}
	// The runner was not stopped by the vetoed restart.
	installjob.Release(job)
	next := claimTestJob(t, app, "install", "gizmos")
	mustNil(t, rebuildJobsFor(app).start(app, next, func(*jobRun) {}))
	awaitDone(t, next, 10*time.Second)

	stop := new(core.TerminateEvent)
	stop.App = app
	mustNil(t, app.OnTerminate().Trigger(stop))
	if len(ran) != 5 {
		t.Fatalf("a terminate ran handlers %v, want all 5", ran)
	}
}

// An auto-upgrade tick in progress holds the terminate, and its ctx ends at
// the terminate, so a lookup waiting on the network returns at once.
func TestLocalScheduler_TerminateWaitsForTheTickAndEndsItsCtx(t *testing.T) {
	s, applied, _ := testScheduler(t, inWindow, nil, okSolve)
	app := s.app.(*tests.TestApp)
	s.jobs = background.For(app, "coreserver")
	s.every = 10 * time.Millisecond

	inDiscover := make(chan struct{})
	var once sync.Once
	var returned atomic.Bool
	s.discover = func(ctx context.Context) ([]VersionInfo, error) {
		once.Do(func() { close(inDiscover) })
		<-ctx.Done()
		// The tick's tail after its ctx ends must still hold the terminate.
		time.Sleep(200 * time.Millisecond)
		returned.Store(true)
		return nil, ctx.Err()
	}
	s.Start(context.Background())
	select {
	case <-inDiscover:
	case <-time.After(10 * time.Second):
		t.Fatal("the tick never reached discovery")
	}

	terminated := make(chan struct{})
	go func() {
		app.Cleanup()
		close(terminated)
	}()
	awaitTerminated(t, terminated, "auto-upgrade tick")
	if !returned.Load() {
		t.Fatal("terminate returned before the tick in progress had")
	}
	if len(*applied) != 0 {
		t.Fatalf("a stopped tick applied %+v", *applied)
	}
}

// After the terminate, a version change is refused rather than started on a
// closing database.
func TestRebuildJobs_StartRefusedAfterTerminate(t *testing.T) {
	app := bootstrappedApp(t)
	jobs := rebuildJobsFor(app)
	runTerminate(app)
	job := claimTestJob(t, app, "install", "widgets")
	if err := jobs.start(app, job, func(*jobRun) { t.Error("job ran after the terminate") }); !errors.Is(err, errRebuildsStopped) {
		t.Fatalf("start after terminate = %v, want %v", err, errRebuildsStopped)
	}
}
