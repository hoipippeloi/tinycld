package maildomains

import (
	"context"
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// One app's claimed registrar must neither serve another app's domain
// operations nor block that app from installing its own. The registrar was a
// last-wins process global: the last app to wire mail performed every app's
// enrollment with its own account token.
func TestRegistrarIsPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetRegistrar(a, stubRegistrar{name: "supervisor"})
	SetResolver(b, stubRegistrar{name: "own"})

	recA, err := Current(a).GetDomain(context.Background(), "acme.com", 0)
	if err != nil || recA.Domain != "supervisor" {
		t.Fatalf("Current(a) = %+v, %v; want the supervisor's registrar", recA, err)
	}
	recB, err := Current(b).GetDomain(context.Background(), "acme.com", 0)
	if err != nil || recB.Domain != "own" {
		t.Fatalf("Current(b) = %+v, %v; want b's own registrar", recB, err)
	}
	if !IsClaimed(a) || IsClaimed(b) {
		t.Fatalf("IsClaimed(a)=%v IsClaimed(b)=%v; want only a claimed", IsClaimed(a), IsClaimed(b))
	}
}

// A sender of app B must never receive app A's Postmark server token.
func TestServerTokenSourceIsPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetServerTokenSource(a, func(context.Context) (string, error) { return "token-a", nil })

	if got, err := ServerToken(context.Background(), a); err != nil || got != "token-a" {
		t.Fatalf("ServerToken(a) = %q, %v; want token-a", got, err)
	}
	if got, err := ServerToken(context.Background(), b); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("ServerToken(b) = %q, %v; want ErrNotConfigured, not app A's token", got, err)
	}
}
