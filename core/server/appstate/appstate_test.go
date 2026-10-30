package appstate_test

import (
	"sync"
	"testing"

	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/appstate"
)

func newApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestKeyIsPerApp(t *testing.T) {
	key := appstate.NewKey[int]("appstate_test.counter")
	a, b := newApp(t), newApp(t)

	key.Set(a, 7)

	if got := key.Get(a); got != 7 {
		t.Fatalf("app A: got %d, want 7", got)
	}
	if got, ok := key.GetOk(b); ok || got != 0 {
		t.Fatalf("app B must not see app A's value: got %d, ok=%v", got, ok)
	}
}

func TestGetOrInitRunsOncePerApp(t *testing.T) {
	key := appstate.NewKey[*sync.Mutex]("appstate_test.mu")
	a, b := newApp(t), newApp(t)

	calls := 0
	init := func() *sync.Mutex { calls++; return &sync.Mutex{} }

	first := key.GetOrInit(a, init)
	second := key.GetOrInit(a, init)
	other := key.GetOrInit(b, init)

	if first != second {
		t.Fatal("GetOrInit returned a different value on the second call for the same app")
	}
	if first == other {
		t.Fatal("two apps share one value")
	}
	if calls != 2 {
		t.Fatalf("init ran %d times, want 2 (once per app)", calls)
	}
}

func TestDelete(t *testing.T) {
	key := appstate.NewKey[string]("appstate_test.name")
	a := newApp(t)
	key.Set(a, "x")
	key.Delete(a)
	if _, ok := key.GetOk(a); ok {
		t.Fatal("value still present after Delete")
	}
}

func TestKeyTypeMismatchReturnsZero(t *testing.T) {
	a := newApp(t)
	appstate.NewKey[string]("appstate_test.clash").Set(a, "text")
	got, ok := appstate.NewKey[int]("appstate_test.clash").GetOk(a)
	if ok || got != 0 {
		t.Fatalf("a key of another type must read as unset: got %d, ok=%v", got, ok)
	}
}

func TestIDIsStableAndUnique(t *testing.T) {
	a, b := newApp(t), newApp(t)
	if appstate.ID(a) != appstate.ID(a) {
		t.Fatal("ID is not stable for one app")
	}
	if appstate.ID(a) == appstate.ID(b) {
		t.Fatal("two apps with different data dirs got the same ID")
	}
	if len(appstate.ID(a)) != 16 {
		t.Fatalf("ID length = %d, want 16", len(appstate.ID(a)))
	}
}
