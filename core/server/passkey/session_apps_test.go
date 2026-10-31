package passkey

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
)

func TestChallengeLedgerIsPerApp(t *testing.T) {
	newApp := func() *tests.TestApp {
		app, err := tests.NewTestApp()
		if err != nil {
			t.Fatalf("NewTestApp: %v", err)
		}
		t.Cleanup(app.Cleanup)
		return app
	}
	a, b := newApp(), newApp()
	expires := time.Now().Add(time.Minute)

	if !challengesFor(a).spend("challenge-1", expires) {
		t.Fatal("first spend on app A refused")
	}
	if challengesFor(a).spend("challenge-1", expires) {
		t.Fatal("app A accepted a spent challenge twice")
	}
	if !challengesFor(b).spend("challenge-1", expires) {
		t.Fatal("app A's spent challenge was recorded on app B")
	}
}
