package davauth

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func newThrottleApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// Guessing at one app's DAV endpoint must not lock the same address and
// user name out of another app in the process.
func TestThrottleIsPerApp(t *testing.T) {
	swapThrottle(t)
	a, b := newThrottleApp(t), newThrottleApp(t)

	for i := 0; i < maxFailures; i++ {
		NoteFailure(a, davRequest(t, "198.51.100.7", "victim@example.com", "guess"))
	}
	if !TooManyFailures(a, davRequest(t, "198.51.100.7", "victim@example.com", "guess")) {
		t.Fatal("app A is not throttled after maxFailures")
	}
	if TooManyFailures(b, davRequest(t, "198.51.100.7", "victim@example.com", "guess")) {
		t.Fatal("app B was throttled by app A's failures")
	}
}
