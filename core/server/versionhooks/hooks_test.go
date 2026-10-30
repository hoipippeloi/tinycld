package versionhooks

import (
	"context"
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestRegister_StoresAndRetrieves(t *testing.T) {
	app := newApp(t)

	snapshotCalled := false
	restoreCalled := false

	Register(app, "notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error {
			snapshotCalled = true
			return nil
		},
		OnRestore: func(_ core.App, _, _ *core.Record) error {
			restoreCalled = true
			return nil
		},
	})

	hook := For(app, "notepads")
	if hook.OnSnapshot == nil || hook.OnRestore == nil {
		t.Fatalf("retrieved hook missing callbacks: %+v", hook)
	}
	if err := hook.OnSnapshot(nil, nil, nil); err != nil {
		t.Errorf("OnSnapshot: %v", err)
	}
	if err := hook.OnRestore(nil, nil, nil); err != nil {
		t.Errorf("OnRestore: %v", err)
	}
	if !snapshotCalled || !restoreCalled {
		t.Errorf("callbacks not invoked: snap=%v restore=%v", snapshotCalled, restoreCalled)
	}
}

func TestRegister_ReplacesOnRereg(t *testing.T) {
	app := newApp(t)

	firstErr := errors.New("first")
	secondErr := errors.New("second")

	Register(app, "notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error { return firstErr },
		OnRestore:  func(_ core.App, _, _ *core.Record) error { return firstErr },
	})
	// Re-register with a hook that only sets OnSnapshot — confirms
	// replacement is full-struct, not field-merge.
	Register(app, "notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error { return secondErr },
	})

	hook := For(app, "notepads")
	if err := hook.OnSnapshot(nil, nil, nil); err != secondErr {
		t.Errorf("OnSnapshot returned %v, want %v (replacement)", err, secondErr)
	}
	if hook.OnRestore != nil {
		t.Errorf("OnRestore should be nil after replacement; got non-nil")
	}
}

func TestFor_ReturnsZeroValueWhenMissing(t *testing.T) {

	hook := For(newApp(t), "never-registered")
	if hook.OnSnapshot != nil || hook.OnRestore != nil {
		t.Errorf("expected zero-value hook, got %+v", hook)
	}
}

func TestRegister_CarriesRenderAndDiff(t *testing.T) {
	app := newApp(t)

	Register(app, "notepads", Hook{
		Render: func(_ context.Context, _ core.App, _, _ *core.Record, user string) (string, error) {
			return "<p>render " + user + "</p>", nil
		},
		Diff: func(_ context.Context, _ core.App, _, _, _ *core.Record, user string) (string, error) {
			return "<p>diff " + user + "</p>", nil
		},
	})

	hook := For(app, "notepads")
	got, err := hook.Render(context.Background(), nil, nil, nil, "u1")
	if err != nil || got != "<p>render u1</p>" {
		t.Fatalf("Render = %q, %v", got, err)
	}
	got, err = hook.Diff(context.Background(), nil, nil, nil, nil, "u1")
	if err != nil || got != "<p>diff u1</p>" {
		t.Fatalf("Diff = %q, %v", got, err)
	}
}

func newApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// Each app's hook closes over that app's own runtime (text's live documents).
// A second app registering the same item type must not replace the first
// app's hook, and an app that registered nothing must find nothing.
func TestHooksAreKeptPerApp(t *testing.T) {
	a, b, bare := newApp(t), newApp(t), newApp(t)
	errA, errB := errors.New("runtime of A"), errors.New("runtime of B")

	Register(a, "notepads", Hook{OnSnapshot: func(core.App, *core.Record, *core.Record) error { return errA }})
	Register(b, "notepads", Hook{OnSnapshot: func(core.App, *core.Record, *core.Record) error { return errB }})

	if err := For(a, "notepads").OnSnapshot(nil, nil, nil); err != errA {
		t.Errorf("app A's hook returned %v, want %v: B's registration replaced it", err, errA)
	}
	if err := For(b, "notepads").OnSnapshot(nil, nil, nil); err != errB {
		t.Errorf("app B's hook returned %v, want %v", err, errB)
	}
	if hook := For(bare, "notepads"); hook.OnSnapshot != nil {
		t.Error("an app that registered no hook found another app's hook")
	}
}
