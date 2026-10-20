// Package shutdown gives each terminate of an app one deadline, which every
// wait in the terminate chain shares.
//
// A process that something will kill (a supervisor, `docker stop`) has a
// fixed time from its SIGTERM to the SIGKILL. The terminate chain waits in
// sequence (a package operation's tail, document saves, the HTTP drain, mail
// writes, background jobs, a backup run), and each wait has its own bound.
// Those bounds add up to more than the time to the kill. When the kill comes
// in the middle of the chain, the waits after it never run, and the
// finalizer that closes the database never runs either.
//
// So each wait takes the lesser of its own bound and the time that is left:
//
//	shutdown.Register(app) // when the wait is bound, next to OnTerminate
//	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
//		ctx, cancel := shutdown.Within(app, widgetStopBound)
//		defer cancel()
//		stopWidgets(ctx)
//		return e.Next()
//	})
//
// The deadline starts in a handler that runs before every other one, so the
// order of the chain decides which wait gets the time: a wait that comes
// early gets all of its bound, and a wait that comes late gets what is left.
// The waits for work that a later boot cannot repair come first.
//
// The deadline leaves FinalizerMargin before the kill, for the finalizer to
// close the database and for the process to exit.
package shutdown

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

// FinalizerMargin is the time the deadline leaves before the kill. In it,
// the chain's finalizer closes the database (SQLite checkpoints its WAL on
// the last close) and the process exits.
const FinalizerMargin = 2 * time.Second

// DefaultKillAfter is the time from a terminate to the kill when nothing
// said otherwise (SetKillAfter): a run with no supervisor, which is a
// development server, a test, or a container that `docker stop` stops. It is
// the supervisor's default stop bound and Docker's default stop timeout, so
// a development run has the same budget as a production stop.
const DefaultKillAfter = 10 * time.Second

// startPriority runs the start of the deadline before every other terminate
// handler, so the deadline covers the whole chain.
const startPriority = -1 << 30

// ErrDeadline is the cause of a Context that ended at the deadline.
var ErrDeadline = errors.New("shutdown: the terminate's deadline has passed")

// ErrTerminated is the cause of a Context that ended because the terminate
// chain returned before the deadline.
var ErrTerminated = errors.New("shutdown: the app has terminated")

const storeKey = "tinycld.shutdown.clock"

// clock is the deadline of one app's terminate.
type clock struct {
	mu        sync.Mutex
	killAfter func() time.Duration
	ctx       context.Context
	cancel    context.CancelCauseFunc
	deadline  time.Time
	timer     *time.Timer
}

// clockOf returns app's clock. The first call binds the start of the
// deadline to app's terminate. The clock lives in app.Store(), so every
// value that shares the app's base (the *pocketbase.PocketBase wrapper, a
// transaction app) finds the same one.
func clockOf(app core.App) *clock {
	return app.Store().GetOrSet(storeKey, func() any {
		c := &clock{killAfter: func() time.Duration { return DefaultKillAfter }}
		c.ctx, c.cancel = context.WithCancelCause(context.Background())
		app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
			Id:       "tinycldShutdownDeadline",
			Priority: startPriority,
			Func: func(e *core.TerminateEvent) error {
				c.begin()
				defer c.end(e.IsRestart)
				return e.Next()
			},
		})
		return c
	}).(*clock)
}

// Register binds the start of app's deadline to its terminate. Call it when
// a terminate wait is bound: a deadline first asked for during the terminate
// starts with the next terminate, not this one. A second call does nothing.
//
// The clock lives in app.Store(). Do not call Register (or any function of
// this package) inside a setFunc of that store's GetOrSet: the store holds
// its lock while it makes a value, so the nested call deadlocks.
func Register(app core.App) {
	clockOf(app)
}

// SetKillAfter tells app's terminate how long after it begins the process is
// killed. fn runs when the terminate begins, so it can tell a stop from a
// drain. Without it, the terminate assumes DefaultKillAfter.
func SetKillAfter(app core.App, fn func() time.Duration) {
	c := clockOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.killAfter = fn
}

// Context returns a context that ends at the deadline of app's terminate,
// with cause ErrDeadline, or when the terminate chain returns first, with
// cause ErrTerminated. Before the terminate begins, it does not end. A
// restart that the chain refused (or whose exec failed) leaves the app
// running, so its deadline does not end the context.
func Context(app core.App) context.Context {
	c := clockOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ctx
}

// Deadline returns the deadline of app's terminate, and false before the
// terminate begins.
func Deadline(app core.App) (time.Time, bool) {
	c := clockOf(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.deadline, !c.deadline.IsZero()
}

// Within returns a context that ends after bound, or at the deadline of
// app's terminate when that comes first. A wait in the terminate chain uses
// it in place of its own timer, so its bound stays its cap.
func Within(app core.App, bound time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(Context(app), bound)
}

func (c *clock) begin() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil {
		// A terminate after one that returned, as a test that calls
		// Cleanup twice does.
		c.ctx, c.cancel = context.WithCancelCause(context.Background())
	}
	budget := max(c.killAfter()-FinalizerMargin, 0)
	c.deadline = time.Now().Add(budget)
	cancel := c.cancel
	c.timer = time.AfterFunc(budget, func() { cancel(ErrDeadline) })
}

// end runs when the chain returns. After a restart the app may still run (a
// veto, a failed exec), so the clock resets and keeps its context open;
// otherwise the app is gone and the context ends.
func (c *clock) end(restart bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.timer.Stop()
	c.deadline = time.Time{}
	if !restart {
		c.cancel(ErrTerminated)
		return
	}
	if c.ctx.Err() != nil {
		c.ctx, c.cancel = context.WithCancelCause(context.Background())
	}
}
