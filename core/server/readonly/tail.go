package readonly

import (
	"context"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
	"tinycld.org/core/shutdown"
)

// tailStopBound bounds how long the app's terminate waits for tail writes in
// flight: long enough for one to finish its save, short enough that a stuck
// push does not hold up shutdown. The terminate's shared deadline
// (tinycld.org/core/shutdown) can cut it shorter.
const tailStopBound = 5 * time.Second

// tailSet tracks the tail writes of one registered app, so its terminate can
// end their waits and let the ones already writing finish before the
// database closes.
type tailSet struct {
	ctx    context.Context
	cancel context.CancelFunc

	// mu orders terminated with wg.Add: once terminated is set, no Add can
	// race the Wait in stop.
	mu         sync.Mutex
	terminated bool
	wg         sync.WaitGroup
}

// tailsKey files an app's tail set on the app itself, so the set goes with the
// app: nothing in the process keeps it after the app is gone.
var tailsKey = appstate.NewKey[*tailSet]("readonly.tails")

func bindTails(app core.App) {
	ctx, cancel := context.WithCancel(context.Background())
	ts := &tailSet{ctx: ctx, cancel: cancel}
	tailsKey.Set(app, ts)
	remember(app)
	// The handler runs before the chain's finalizer, which closes the
	// database, so every parked tail is ended before the close.
	shutdown.Register(app)
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		// A terminated app takes no further SIGUSR2.
		forget(app)
		ctx, cancel := shutdown.Within(app, tailStopBound)
		defer cancel()
		ts.stop(ctx)
		return e.Next()
	})
}

// stop ends every parked tail and waits for the ones already writing until
// ctx ends.
func (ts *tailSet) stop(ctx context.Context) {
	ts.mu.Lock()
	ts.terminated = true
	ts.cancel()
	ts.mu.Unlock()

	done := make(chan struct{})
	go func() {
		ts.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		log.Warn("closing the app under tail writes that did not finish in time",
			"bound", tailStopBound, "cause", context.Cause(ctx))
	}
}

// TailContext returns the context a tail write (one that follows a request
// already accepted) waits under in WhenWritable, and a release func the tail
// must call when it has finished. The context ends after TailWait or when
// app terminates, whichever comes first. A supervised upgrade keeps the mode
// on until the process exits, so without the terminate the wait would
// outlive the process and the drop would never be logged.
//
// Call it before starting the tail's goroutine. For an app that was not
// passed to Register, only TailWait bounds the wait.
func TailContext(app core.App) (context.Context, func()) {
	ts, ok := tailsKey.GetOk(app)
	if !ok {
		return context.WithTimeout(context.Background(), TailWait)
	}

	ctx, cancel := context.WithTimeout(ts.ctx, TailWait)
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.terminated {
		// ctx is already done: the app is closing.
		return ctx, cancel
	}
	ts.wg.Add(1)
	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel()
			ts.wg.Done()
		})
	}
}
