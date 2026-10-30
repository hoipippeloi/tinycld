package previewqueue

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func newQueueApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestStashThenTakeIsSelfClearing(t *testing.T) {
	app := newQueueApp(t)
	want := Payload{Plaintext: "hello", RegionHash: "rh", IndexHash: "ih"}
	Stash(app, "item-1", want)

	got, ok := Take(app, "item-1")
	if !ok {
		t.Fatal("first Take: ok = false, want true")
	}
	if got.Plaintext != want.Plaintext || got.RegionHash != want.RegionHash || got.IndexHash != want.IndexHash {
		t.Fatalf("first Take payload = %+v, want %+v", got, want)
	}
	if _, ok := Take(app, "item-1"); ok {
		t.Fatal("second Take: ok = true, want false (Take should self-clear)")
	}
}

func TestTakeUnknownID(t *testing.T) {
	if _, ok := Take(newQueueApp(t), "does-not-exist"); ok {
		t.Fatal("Take of unknown id: ok = true, want false")
	}
}

func TestStashTwiceOverwrites(t *testing.T) {
	app := newQueueApp(t)
	Stash(app, "item-1", Payload{Plaintext: "first"})
	Stash(app, "item-1", Payload{Plaintext: "second"})

	got, ok := Take(app, "item-1")
	if !ok || got.Plaintext != "second" {
		t.Fatalf("payload = %q (ok=%v), want last-write %q", got.Plaintext, ok, "second")
	}
}

// Item ids are unique only in their app: one app's render hook must not take
// the payload another app stashed.
func TestQueueIsPerApp(t *testing.T) {
	a, b := newQueueApp(t), newQueueApp(t)
	Stash(a, "item-1", Payload{Plaintext: "app a"})

	if _, ok := Take(b, "item-1"); ok {
		t.Fatal("app B took app A's payload")
	}
	if got, ok := Take(a, "item-1"); !ok || got.Plaintext != "app a" {
		t.Fatal("app A lost its own payload")
	}
}
