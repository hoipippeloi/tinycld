package readonly

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func bareApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

// Two apps in one process each have their own switch: app A going read-only
// must not stop app B's writes, wake B's waiters, or run B's OnEnter fns.
func TestModeIsPerApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	var aRan, bRan atomic.Int32
	OnEnter(a, func() { aRan.Add(1) })
	OnEnter(b, func() { bRan.Add(1) })

	Enter(a)
	t.Cleanup(func() { Leave(a) })
	if !Active(a) {
		t.Fatal("Enter(a) did not switch a's mode on")
	}
	if Active(b) {
		t.Fatal("Enter(a) switched b's mode on")
	}
	if aRan.Load() != 1 || bRan.Load() != 0 {
		t.Fatalf("OnEnter ran a=%d b=%d, want a=1 b=0", aRan.Load(), bRan.Load())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := WaitInactive(ctx, b); err != nil {
		t.Fatalf("WaitInactive(b) = %v while only a is read-only, want nil", err)
	}
	ran := false
	if err := WhenWritable(context.Background(), b, func() error { ran = true; return nil }); err != nil || !ran {
		t.Fatalf("WhenWritable(b) = %v, ran %v; want b to write while a is read-only", err, ran)
	}

	Leave(b) // leaving b must not leave a
	if !Active(a) {
		t.Fatal("Leave(b) switched a's mode off")
	}
}

// The cron guard sits on each app's own scheduler and reads that app's mode.
func TestCronGuardReadsItsOwnApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	Enter(a)
	t.Cleanup(func() { Leave(a) })
	if !skipCronTick(a, "probe") {
		t.Fatal("a's cron tick ran while a is read-only")
	}
	if skipCronTick(b, "probe") {
		t.Fatal("b's cron tick was skipped because a is read-only")
	}
}

// The middleware refuses by the mode of the app serving the request.
func TestMiddlewareServesAnotherAppWhileOneIsReadOnly(t *testing.T) {
	a := bareApp(t)
	Enter(a)
	t.Cleanup(func() { Leave(a) })
	(&tests.ApiScenario{
		Method:          http.MethodPost,
		URL:             "/api/x",
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{"handled"},
		TestAppFactory: func(t testing.TB) *tests.TestApp {
			b, err := tests.NewTestApp()
			if err != nil {
				t.Fatal(err)
			}
			Register(b)
			b.OnServe().BindFunc(func(e *core.ServeEvent) error {
				e.Router.POST("/api/x", func(re *core.RequestEvent) error { return re.String(http.StatusOK, "handled") })
				return e.Next()
			})
			return b
		},
	}).Test(t)
}

// Terminating app A ends A's parked tails and nothing of app B's.
func TestTerminatingOneAppLeavesAnotherAppsTails(t *testing.T) {
	a := registeredTestApp(t)
	b := registeredTestApp(t)
	t.Cleanup(b.Cleanup)

	ctxA, releaseA := TailContext(a)
	ctxB, releaseB := TailContext(b)
	defer releaseB()

	cleaned := make(chan struct{})
	go func() {
		a.Cleanup()
		close(cleaned)
	}()
	select {
	case <-ctxA.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("a's terminate did not end a's tail")
	}
	if ctxB.Err() != nil {
		t.Fatalf("a's terminate ended b's tail: %v", ctxB.Err())
	}
	releaseA()
	select {
	case <-cleaned:
	case <-time.After(5 * time.Second):
		t.Fatal("a did not finish terminating after its tail was released")
	}
}
