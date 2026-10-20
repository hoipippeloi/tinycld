package coreserver

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"

	"tinycld.org/core/installjob"
	"tinycld.org/core/shutdown"
)

// A package install, uninstall, revert or version change runs for minutes on
// its own goroutine: it fetches packages, runs pnpm, go and expo, then backs
// up the database, syncs its migrations and switches the live build. The app
// can terminate at any point of that. rebuildJobs ties the job to the app's
// lifetime:
//
//   - The terminate cancels the job's ctx. Every build command is bound to
//     it, so the command and the processes it started are killed, and the
//     job fails at once and records the failure on its pkg_install_log row.
//   - The job does not start the database tail (backup → migration sync →
//     switch to the new build → registry → finalize) once ctx has ended. A
//     job already in the tail when the terminate comes finishes the tail, so
//     the terminate waits longer for it.
//   - A panic in the job is recovered, logged and recorded on the row.
//
// The terminate never waits without a bound. A job that is still running
// when its bound or the terminate's shared deadline ends is left to the
// finalizer, which closes the database under it.

// rebuildStopPriority runs the terminate handler first, after only the start
// of the shared deadline (tinycld.org/core/shutdown). The cancel then
// reaches the build commands at once, not after other handlers' waits, and
// a job in its database tail gets the first share of the deadline: a tail
// cut in the middle is the one state a later boot does not repair. The
// watcher-restart veto is in the same handler, so a vetoed restart runs no
// other terminate handler either.
const rebuildStopPriority = -20000

// The terminate's wait for a cancelled job. Both bounds fit inside the
// shared deadline of a supervised stop (supervise's stopBound, 10 s, less
// shutdown.FinalizerMargin), and as the first wait in the chain the job gets
// all of its bound. A backup run, the other long wait in the terminate
// chain, claims the same single-flight slot as a rebuild, so the two waits
// never add up.
var (
	// rebuildCancelGrace is how long a job that is still building has to
	// record its failure after the cancel. Its commands are killed by the
	// cancel, so it needs only the time of one row save.
	rebuildCancelGrace = 2 * time.Second
	// rebuildTailStopBound is how long a job in the database tail has to
	// finish it. The tail is a migration sync, a symlink swap, a pool
	// re-open and a few row saves; the backup copy before it stops at the
	// cancel.
	rebuildTailStopBound = 6 * time.Second
)

// errRebuildCancelled marks a job the terminate stopped. It is recorded as a
// failure, but it is not a fault: it is not reported to Sentry.
var errRebuildCancelled = errors.New("the server stopped before the operation finished")

// errRebuildsStopped is what start returns once the app is terminating.
var errRebuildsStopped = errors.New("the server is shutting down; try again when it is back")

const rebuildJobsStoreKey = "tinycld.coreserver.rebuildJobs"

// rebuildJobs runs the package operations of one app. The installjob
// interlock allows one at a time, so it tracks at most one run.
type rebuildJobs struct {
	// app is the app whose terminate stops the runner; its shared deadline
	// bounds the stop's wait.
	app    core.App
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	stopped bool
	current *jobRun
}

// rebuildJobsFor returns app's runner. The first call binds its stop to the
// app's terminate, together with the watcher-restart veto.
func rebuildJobsFor(app core.App) *rebuildJobs {
	// Outside the GetOrSet below: Register makes its own store value, and a
	// nested GetOrSet on the same store deadlocks.
	shutdown.Register(app)
	return app.Store().GetOrSet(rebuildJobsStoreKey, func() any {
		ctx, cancel := context.WithCancel(context.Background())
		jobs := &rebuildJobs{app: app, ctx: ctx, cancel: cancel}
		app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
			Priority: rebuildStopPriority,
			Func: func(e *core.TerminateEvent) error {
				// Guard against a hooks-watcher (HooksWatch) restart firing
				// in the MIDDLE of a pipeline. Those pipelines re-run the
				// generator, which rewrites the watched pb_hooks symlinks;
				// with HooksWatch on, PocketBase's jsvm watcher would call
				// app.Restart() (an in-process re-exec) and tear the process
				// down between, say, the file swap and the migration step —
				// leaving a half-applied state with no rollback.
				// app.Restart() routes through OnTerminate with
				// IsRestart=true, so it is vetoed while a job holds the
				// single-flight lock. Our OWN intentional restarts use
				// os.Exit(75) or the supervisor (requestRestart), a path
				// this guard never sees.
				if shouldSuppressRestart(e.IsRestart) {
					srvLog.Info("suppressing watcher restart — a package operation is in progress")
					return nil // short-circuit: no other terminate handler runs
				}
				jobs.stop()
				return e.Next()
			},
		})
		return jobs
	}).(*rebuildJobs)
}

// start runs fn as job on its own goroutine. The caller has claimed job in
// the installjob interlock; start releases it when fn returns, and the
// caller releases it itself when start returns an error.
func (r *rebuildJobs) start(app core.App, job *installjob.Job, fn func(run *jobRun)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return errRebuildsStopped
	}
	run := &jobRun{ctx: r.ctx, app: app, job: job, done: make(chan struct{})}
	r.current = run
	go run.exec(fn)
	return nil
}

// stop cancels the running job and waits for it: up to rebuildTailStopBound
// when it is in the database tail, up to rebuildCancelGrace otherwise, and
// never past the terminate's shared deadline. Then it stops the job's
// progress saver, so no throttled save reaches the database after it closes.
func (r *rebuildJobs) stop() {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.stopped = true
	run := r.current
	r.mu.Unlock()

	if run == nil {
		r.cancel()
		return
	}
	// The cancel and the tail read happen under the run's lock, which
	// enterTail also takes: either the job entered the tail before the
	// cancel, or it sees the cancel and does not enter it.
	run.mu.Lock()
	r.cancel()
	inTail := run.inTail
	run.mu.Unlock()

	bound := rebuildCancelGrace
	if inTail {
		bound = rebuildTailStopBound
	}
	ctx, cancel := shutdown.Within(r.app, bound)
	defer cancel()
	select {
	case <-run.done:
	case <-ctx.Done():
		srvLog.Warn("closing the app under a package operation that did not stop in time",
			"jobID", run.job.ID, "action", run.job.Action, "inTail", inTail, "bound", bound,
			"cause", context.Cause(ctx))
	}
	progressSaverFor(run.job.ID).stop()
}

// jobRun is one package operation's tie to the app's lifetime.
type jobRun struct {
	// ctx ends when the app terminates.
	ctx  context.Context
	app  core.App
	job  *installjob.Job
	done chan struct{}

	mu        sync.Mutex
	inTail    bool
	logRecord *core.Record
}

// detachedRun is a jobRun that no runner stops: a restore's rebuild, which
// the backup engine runs under its own ctx and stop bound, and the
// orchestrator's unit tests.
func detachedRun(ctx context.Context) *jobRun {
	return &jobRun{ctx: ctx}
}

// exec runs fn, recovers a panic in it, and releases the interlock last, so
// the failure is recorded before another job can start.
func (run *jobRun) exec(fn func(run *jobRun)) {
	defer close(run.done)
	defer finishJob(run.job)
	defer func() {
		if p := recover(); p != nil {
			srvLog.Error("package operation panicked",
				"jobID", run.job.ID, "action", run.job.Action,
				"panic", fmt.Sprint(p), "stack", string(debug.Stack()))
			run.recordPanic(p)
		}
	}()
	fn(run)
}

// createLog creates the job's pkg_install_log row and remembers it, so a
// panic can still record the failure on it.
func (run *jobRun) createLog(action string) *core.Record {
	rec := createInstallLog(run.app, run.job, action)
	run.mu.Lock()
	run.logRecord = rec
	run.mu.Unlock()
	return rec
}

// recordPanic marks the job and its row failed, unless the job had already
// recorded its outcome. The database may be the cause of the panic (closed
// under the job), so a second panic here is only logged.
func (run *jobRun) recordPanic(p any) {
	defer func() {
		if p2 := recover(); p2 != nil {
			srvLog.Error("could not record the failed package operation",
				"jobID", run.job.ID, "panic", fmt.Sprint(p2))
		}
	}()
	err := fmt.Errorf("internal error: %v", p)
	run.mu.Lock()
	rec := run.logRecord
	run.mu.Unlock()
	if rec != nil && rec.GetString("status") == "running" {
		finalizeInstallLog(run.app, rec, "failed", err.Error(), run.job.LogLines)
	}
	if run.job.Status != "success" && run.job.Status != "failed" {
		_ = failJob(run.job, "internal", err)
	}
}

// enterTail marks the start of the database tail. It refuses once ctx has
// ended: a job stopped before its tail fails with the database untouched.
func (run *jobRun) enterTail() error {
	run.mu.Lock()
	defer run.mu.Unlock()
	if err := run.checkpoint(); err != nil {
		return err
	}
	run.inTail = true
	return nil
}

// checkpoint is the error to stop with at a step boundary once ctx has
// ended, or nil.
func (run *jobRun) checkpoint() error {
	if err := run.ctx.Err(); err != nil {
		return fmt.Errorf("%w: %w", errRebuildCancelled, err)
	}
	return nil
}

// cause is err, marked as the terminate's when ctx has ended: a command the
// cancel killed fails with "signal: killed", which says nothing about why.
func (run *jobRun) cause(err error) error {
	if err == nil || errors.Is(err, errRebuildCancelled) || run.ctx.Err() == nil {
		return err
	}
	return fmt.Errorf("%w: %w", errRebuildCancelled, err)
}

// stopping reports whether the app is terminating.
func (run *jobRun) stopping() bool {
	return run.ctx.Err() != nil
}
