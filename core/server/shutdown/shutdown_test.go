package shutdown

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

func newApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

func terminate(t *testing.T, app core.App, restart bool) {
	t.Helper()
	e := &core.TerminateEvent{App: app, IsRestart: restart}
	if err := app.OnTerminate().Trigger(e, func(*core.TerminateEvent) error { return nil }); err != nil {
		t.Fatalf("terminate: %v", err)
	}
}

// Three waits in a row, each with its own bound, share one deadline that is
// shorter than their sum. The first gets all of its bound, the second gets
// what is left, and the third gets nothing; the chain returns at the
// deadline, not after the sum of the bounds.
func TestWithin_LaterWaitsGetOnlyWhatIsLeft(t *testing.T) {
	const (
		budget = time.Second
		bound  = 600 * time.Millisecond
	)
	app := newApp(t)
	SetKillAfter(app, func() time.Duration { return FinalizerMargin + budget })

	took := make([]time.Duration, 3)
	for i := range took {
		app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
			Priority: i + 1,
			Func: func(e *core.TerminateEvent) error {
				start := time.Now()
				ctx, cancel := Within(app, bound)
				defer cancel()
				<-ctx.Done()
				took[i] = time.Since(start)
				return e.Next()
			},
		})
	}

	start := time.Now()
	terminate(t, app, false)
	total := time.Since(start)

	if took[0] < bound {
		t.Errorf("the first wait got %v, want its whole bound %v", took[0], bound)
	}
	// The sum of the bounds is 1.8 s; the deadline is 1 s.
	if total >= budget+400*time.Millisecond {
		t.Errorf("the chain took %v; the waits did not share the %v deadline", total, budget)
	}
	if took[1] >= bound-50*time.Millisecond {
		t.Errorf("the second wait got %v, want only what the first left (about %v)", took[1], budget-bound)
	}
	if took[2] >= 300*time.Millisecond {
		t.Errorf("the third wait got %v after the deadline had passed, want about 0", took[2])
	}
}

// The context ends at the deadline with ErrDeadline, and when the chain
// returns first, with ErrTerminated.
func TestContext_Causes(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		app := newApp(t)
		SetKillAfter(app, func() time.Duration { return FinalizerMargin + 50*time.Millisecond })
		var cause error
		app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
			ctx := Context(app)
			<-ctx.Done()
			cause = context.Cause(ctx)
			return e.Next()
		})
		terminate(t, app, false)
		if !errors.Is(cause, ErrDeadline) {
			t.Fatalf("cause = %v, want ErrDeadline", cause)
		}
	})
	t.Run("terminated", func(t *testing.T) {
		app := newApp(t)
		ctx := Context(app)
		if ctx.Err() != nil {
			t.Fatal("the context ended before the terminate")
		}
		terminate(t, app, false)
		if !errors.Is(context.Cause(ctx), ErrTerminated) {
			t.Fatalf("cause = %v, want ErrTerminated", context.Cause(ctx))
		}
		if _, ok := Deadline(app); ok {
			t.Fatal("a deadline is still set after the terminate returned")
		}
	})
}

// A kill bound shorter than the margin leaves no time at all, not a negative
// one.
func TestDeadline_NoTimeLeftWhenTheKillComesBeforeTheMargin(t *testing.T) {
	app := newApp(t)
	SetKillAfter(app, func() time.Duration { return FinalizerMargin / 2 })
	var left time.Duration
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		d, ok := Deadline(app)
		if !ok {
			t.Error("no deadline during the terminate")
		}
		left = time.Until(d)
		<-Context(app).Done()
		return e.Next()
	})
	terminate(t, app, false)
	if left > 0 {
		t.Fatalf("time left = %v, want none", left)
	}
}

// Without SetKillAfter, the deadline assumes DefaultKillAfter.
func TestDeadline_DefaultKillAfter(t *testing.T) {
	app := newApp(t)
	Register(app)
	var left time.Duration
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		d, _ := Deadline(app)
		left = time.Until(d)
		return e.Next()
	})
	terminate(t, app, false)
	want := DefaultKillAfter - FinalizerMargin
	if left > want || left < want-time.Second {
		t.Fatalf("time left = %v, want about %v", left, want)
	}
}

// A restart that a handler refuses leaves the app running: its deadline is
// cleared and the context stays open, so the next terminate gets a fresh
// deadline.
func TestDeadline_RefusedRestartResets(t *testing.T) {
	app := newApp(t)
	Register(app)
	app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
		Priority: -100,
		Func: func(e *core.TerminateEvent) error {
			if e.IsRestart {
				return nil
			}
			return e.Next()
		},
	})
	ctx := Context(app)
	terminate(t, app, true)
	if _, ok := Deadline(app); ok {
		t.Fatal("a refused restart left its deadline set")
	}
	if ctx.Err() != nil {
		t.Fatal("a refused restart ended the context")
	}

	var during bool
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		_, during = Deadline(app)
		return e.Next()
	})
	terminate(t, app, false)
	if !during {
		t.Fatal("the terminate after a refused restart had no deadline")
	}
	if ctx.Err() == nil {
		t.Fatal("the context did not end with the terminate")
	}
}

// Register binds one start handler per app, however often it is called.
func TestRegister_OncePerApp(t *testing.T) {
	app := newApp(t)
	before := app.OnTerminate().Length()
	Register(app)
	Register(app)
	SetKillAfter(app, func() time.Duration { return time.Second })
	if got := app.OnTerminate().Length() - before; got != 1 {
		t.Fatalf("want one terminate handler, got %d", got)
	}
}
