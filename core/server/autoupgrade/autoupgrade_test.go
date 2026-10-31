package autoupgrade

import (
	"context"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

type fake struct{}

func (fake) PolicyChanged(context.Context, bool) error { return nil }
func (fake) Status(context.Context) (Status, error)    { return Status{Available: true}, nil }

func bareApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

func TestSetDelegate(t *testing.T) {
	app := bareApp(t)
	if Current(app) != nil {
		t.Fatal("expected no delegate")
	}
	SetDelegate(app, fake{})
	if Current(app) == nil {
		t.Fatal("delegate not installed")
	}
	SetDelegate(app, nil)
	if Current(app) != nil {
		t.Fatal("SetDelegate(nil) did not remove the delegate")
	}
}

// Each app's switch goes to its own delegate: a second app in the process
// must not answer to the first app's.
func TestDelegateIsPerApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	SetDelegate(a, fake{})
	if Current(b) != nil {
		t.Fatal("a's delegate answers for b")
	}
}

func TestUnavailable(t *testing.T) {
	s := Unavailable("no toolchain")
	if s.Available || s.Reason != "no toolchain" {
		t.Fatalf("got %+v", s)
	}
}
