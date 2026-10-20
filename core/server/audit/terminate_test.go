package audit

import (
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// The audit row is written after the request that caused it has answered.
// When the app terminates while the row is still being written, the
// terminate must wait for it: a write after the database closes panics the
// process, and the row is lost.
func TestAuditRow_TerminateWaitsForTheWrite(t *testing.T) {
	app, rec := auditTestAppNoCleanup(t)

	hit := make(chan struct{}, 1)
	saved := make(chan error, 1)
	release := make(chan struct{})
	var once sync.Once
	letGo := func() { once.Do(func() { close(release) }) }
	t.Cleanup(app.Cleanup)
	// Runs before the app's Cleanup (cleanups run last-in first-out), which
	// would otherwise wait forever on the held write after a failed
	// assertion.
	t.Cleanup(letGo)
	app.OnRecordCreate("audit_logs").BindFunc(func(e *core.RecordEvent) error {
		select {
		case hit <- struct{}{}:
		default:
		}
		<-release
		err := e.Next()
		saved <- err
		return err
	})

	logWhenWritable(app, "widgets", rec.Id, func() {
		logCreate(app, rec, requestInfoOf(nil), "widgets", DefaultLabelExtractor)
	})
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the audit row never reached its save")
	}

	terminated := make(chan struct{})
	go func() {
		app.Cleanup()
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatal("terminate returned while the audit row was still being written")
	case <-time.After(300 * time.Millisecond):
	}

	letGo()
	select {
	case err := <-saved:
		if err != nil {
			t.Fatalf("the audit row was saved against a closed database: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the audit row was not saved after the hold ended")
	}
	select {
	case <-terminated:
	case <-time.After(10 * time.Second):
		t.Fatal("terminate did not return after the audit row was written")
	}
}
