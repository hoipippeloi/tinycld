package automation

import (
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// The notice that a rule was disabled is written after the dispatch that
// disabled it has moved on. When the app terminates while the notice is
// still being written, the terminate must wait for it: a write after the
// database closes panics the process.
func TestAutoDisable_TerminateWaitsForTheNotice(t *testing.T) {
	app, rule := runsApp(t)

	hit := make(chan struct{}, 1)
	saved := make(chan error, 1)
	release := make(chan struct{})
	var once sync.Once
	letGo := func() { once.Do(func() { close(release) }) }
	// Runs before the app's Cleanup, which runsApp registered earlier
	// (cleanups run last-in first-out) and which would otherwise wait
	// forever on the held write after a failed assertion.
	t.Cleanup(letGo)
	app.OnRecordCreate("notifications").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("type") != "automation_disabled" {
			return e.Next()
		}
		select {
		case hit <- struct{}{}:
		default:
		}
		<-release
		err := e.Next()
		saved <- err
		return err
	})

	for i := 0; i < autoDisableAfter; i++ {
		recordRunResult(app, rule, true)
	}
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the rule disabled notice never reached its save")
	}

	testApp := app.(*tests.TestApp)
	terminated := make(chan struct{})
	go func() {
		testApp.Cleanup()
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatal("terminate returned while the rule disabled notice was still being written")
	case <-time.After(300 * time.Millisecond):
	}

	letGo()
	select {
	case err := <-saved:
		if err != nil {
			t.Fatalf("the notice was saved against a closed database: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the notice was not saved after the hold ended")
	}
	select {
	case <-terminated:
	case <-time.After(10 * time.Second):
		t.Fatal("terminate did not return after the notice was written")
	}
}
