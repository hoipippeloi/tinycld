package editcheckpoint

import (
	"context"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func newApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

func TestFire_CallsRegisteredListener(t *testing.T) {
	app := newApp(t)
	var gotID string
	var gotReason Reason
	var gotEditors Editors
	Register(app, func(_ context.Context, id string, e Editors, r Reason) {
		gotID, gotEditors, gotReason = id, e, r
	})
	Fire(context.Background(), app, "item1", Editors{UserIDs: []string{"u1"}}, ReasonIdle)
	if gotID != "item1" || gotReason != ReasonIdle || len(gotEditors.UserIDs) != 1 {
		t.Fatalf("got %q %q %+v", gotID, gotReason, gotEditors)
	}
}

func TestFire_NoListenerIsNoop(t *testing.T) {
	Fire(context.Background(), newApp(t), "item1", Editors{}, ReasonIdle)
	Fire(context.Background(), nil, "item1", Editors{}, ReasonIdle)
}

// Each app keeps its own listener: a checkpoint in app A must make a version
// in A only. With one listener for the process, the last app to register
// received every app's checkpoints and wrote versions into its own database.
func TestListenerIsPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	var gotA, gotB []string
	Register(a, func(_ context.Context, id string, _ Editors, _ Reason) { gotA = append(gotA, id) })
	Register(b, func(_ context.Context, id string, _ Editors, _ Reason) { gotB = append(gotB, id) })

	Fire(context.Background(), a, "in-a", Editors{UserIDs: []string{"u"}}, ReasonIdle)

	if len(gotA) != 1 || gotA[0] != "in-a" {
		t.Fatalf("app A's listener got %v, want [in-a]", gotA)
	}
	if len(gotB) != 0 {
		t.Fatalf("app B's listener got app A's checkpoint: %v", gotB)
	}
}

func TestEditors_Empty(t *testing.T) {
	if !(Editors{}).Empty() {
		t.Fatal("zero Editors should be empty")
	}
	if (Editors{ShareNames: []string{"Anon Otter"}}).Empty() {
		t.Fatal("an anonymous editor is not empty")
	}
}
