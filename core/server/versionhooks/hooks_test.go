package versionhooks

import (
	"context"
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestRegister_StoresAndRetrieves(t *testing.T) {
	t.Cleanup(ResetForTest)
	ResetForTest()

	snapshotCalled := false
	restoreCalled := false

	Register("notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error {
			snapshotCalled = true
			return nil
		},
		OnRestore: func(_ core.App, _, _ *core.Record) error {
			restoreCalled = true
			return nil
		},
	})

	hook := For("notepads")
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
	t.Cleanup(ResetForTest)
	ResetForTest()

	firstErr := errors.New("first")
	secondErr := errors.New("second")

	Register("notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error { return firstErr },
		OnRestore:  func(_ core.App, _, _ *core.Record) error { return firstErr },
	})
	// Re-register with a hook that only sets OnSnapshot — confirms
	// replacement is full-struct, not field-merge.
	Register("notepads", Hook{
		OnSnapshot: func(_ core.App, _, _ *core.Record) error { return secondErr },
	})

	hook := For("notepads")
	if err := hook.OnSnapshot(nil, nil, nil); err != secondErr {
		t.Errorf("OnSnapshot returned %v, want %v (replacement)", err, secondErr)
	}
	if hook.OnRestore != nil {
		t.Errorf("OnRestore should be nil after replacement; got non-nil")
	}
}

func TestFor_ReturnsZeroValueWhenMissing(t *testing.T) {
	t.Cleanup(ResetForTest)
	ResetForTest()

	hook := For("never-registered")
	if hook.OnSnapshot != nil || hook.OnRestore != nil {
		t.Errorf("expected zero-value hook, got %+v", hook)
	}
}

func TestRegister_CarriesRenderAndDiff(t *testing.T) {
	t.Cleanup(ResetForTest)
	ResetForTest()

	Register("notepads", Hook{
		Render: func(_ context.Context, _ core.App, _, _ *core.Record, user string) (string, error) {
			return "<p>render " + user + "</p>", nil
		},
		Diff: func(_ context.Context, _ core.App, _, _, _ *core.Record, user string) (string, error) {
			return "<p>diff " + user + "</p>", nil
		},
	})

	hook := For("notepads")
	got, err := hook.Render(context.Background(), nil, nil, nil, "u1")
	if err != nil || got != "<p>render u1</p>" {
		t.Fatalf("Render = %q, %v", got, err)
	}
	got, err = hook.Diff(context.Background(), nil, nil, nil, nil, "u1")
	if err != nil || got != "<p>diff u1</p>" {
		t.Fatalf("Diff = %q, %v", got, err)
	}
}
