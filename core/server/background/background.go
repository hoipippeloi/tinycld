// Package background runs the work a package moves off the request goroutine
// (notifications, thumbnails, text extraction, sweeps on a ticker) and holds
// the app's terminate until that work has finished.
//
// A bare goroutine outlives the app: the terminate's finalizer closes the
// database, and the goroutine's next query panics on the nil handle. A bare
// goroutine has no recover, so that panic ends the whole process, and in a
// test it outlives app.Cleanup() and crashes `go test`. A check on
// ConcurrentDB() inside the goroutine cannot prevent it: it races the close.
//
//	jobs := background.For(app, "widgets")
//	jobs.Run("widget notification", func(ctx context.Context) {
//		notifyWidgetShared(ctx, app, record)
//	})
//
// A job must return soon after ctx ends: the terminate waits for it with no
// bound. A long-running loop selects on ctx.Done().
package background

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sort"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/logging"
)

// storeKeyPrefix namespaces the runners in the app's store. The store, not a
// process-wide map, holds them: a runner then lives exactly as long as its
// app, and every value that shares the app's base (the *pocketbase.PocketBase
// wrapper, a transaction app) finds the same runner.
const storeKeyPrefix = "tinycld.background."

// stallWarnInterval is how often a terminate that is still waiting logs the
// jobs it waits for. The wait itself has no bound; the log tells an operator
// which job holds up a shutdown.
var stallWarnInterval = 10 * time.Second

// Jobs runs one package's background work for one app.
type Jobs struct {
	log *slog.Logger

	// ctx ends when the app terminates, so a running job stops before its
	// next write and a render in progress is cancelled.
	ctx    context.Context
	cancel context.CancelFunc

	// mu orders stopped with wg.Add: once stopped is set, no Add can race
	// the Wait in stop (sync.WaitGroup forbids that). It also guards running.
	mu      sync.Mutex
	stopped bool
	nextID  uint64
	running map[uint64]string
	wg      sync.WaitGroup
}

// For returns the runner of pkg's background work for app. The first call for
// an app and pkg binds the runner to the app's terminate; later calls return
// the same runner, so each register function of a package may call For
// itself. pkg names the logger (logging.ForPackage) the runner logs through.
//
// After the app has terminated, For returns the stopped runner, which drops
// every job.
//
// The runner lives in app.Store(). Do not call For inside a setFunc of that
// store's GetOrSet: the store holds its lock while it makes a value, so the
// nested read deadlocks. Call For first and capture the runner.
func For(app core.App, pkg string) *Jobs {
	v := app.Store().GetOrSet(storeKeyPrefix+pkg, func() any {
		return bind(app, pkg)
	})
	return v.(*Jobs)
}

// bind makes the runner and binds its stop to the app's terminate. The
// handler runs before the chain's finalizer, which closes the database, so
// every job has finished before the close.
func bind(app core.App, pkg string) *Jobs {
	ctx, cancel := context.WithCancel(context.Background())
	jobs := &Jobs{
		log:     logging.ForPackage(pkg),
		ctx:     ctx,
		cancel:  cancel,
		running: map[uint64]string{},
	}
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		jobs.stop()
		return e.Next()
	})
	return jobs
}

// Run starts fn in its own goroutine and reports whether it started. A panic
// in fn is recovered and logged with its stack. After the app has begun to
// terminate, Run drops fn and logs a warning: the database it needs is about
// to close.
//
// name says what the job does ("drive share notification"); the logs carry
// it.
func (j *Jobs) Run(name string, fn func(ctx context.Context)) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.stopped {
		j.log.Warn("background job dropped: the app is terminating", "job", name)
		return false
	}
	id := j.nextID
	j.nextID++
	j.running[id] = name
	j.wg.Add(1)
	go j.exec(id, name, fn)
	return true
}

func (j *Jobs) exec(id uint64, name string, fn func(ctx context.Context)) {
	defer j.wg.Done()
	defer j.finished(id)
	defer func() {
		if r := recover(); r != nil {
			j.log.Error("background job panicked",
				"job", name, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
		}
	}()
	fn(j.ctx)
}

func (j *Jobs) finished(id uint64) {
	j.mu.Lock()
	delete(j.running, id)
	j.mu.Unlock()
}

// stop refuses new jobs, ends ctx, and waits for the running ones. The wait
// has no bound, as the fork's own background file deletes have none: a job
// still running when the database closes is the crash this type prevents.
// The cancelled ctx makes the wait short, because each job stops at its next
// check. A second stop (a test that calls app.Cleanup twice) returns at once.
func (j *Jobs) stop() {
	j.mu.Lock()
	j.stopped = true
	j.cancel()
	j.mu.Unlock()

	done := make(chan struct{})
	go func() {
		j.wg.Wait()
		close(done)
	}()
	ticker := time.NewTicker(stallWarnInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			j.log.Warn("terminate is waiting for background jobs that have not stopped",
				"jobs", j.runningNames())
		}
	}
}

func (j *Jobs) runningNames() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	names := make([]string, 0, len(j.running))
	for _, name := range j.running {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
