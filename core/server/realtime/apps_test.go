package realtime

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newRealtimeApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// Every app owns its room kinds. The registry was process-wide: the second
// app's Register panicked on a duplicate kind, and the closures captured the
// first app, so the second app's connections were authorized against the
// first app's database.
func TestRoomKindsArePerApp(t *testing.T) {
	a, b := newRealtimeApp(t), newRealtimeApp(t)
	errA, errB := errors.New("authorized by a"), errors.New("authorized by b")
	RegisterRoomKind(a, "shared", func(*core.Record, string) error { return errA })
	RegisterRoomKind(b, "shared", func(*core.Record, string) error { return errB })

	if err := LookupForTest(a, "shared")(nil, "room"); !errors.Is(err, errA) {
		t.Fatalf("app A's kind answered %v, want its own handler", err)
	}
	if err := LookupForTest(b, "shared")(nil, "room"); !errors.Is(err, errB) {
		t.Fatalf("app B's kind answered %v, want its own handler", err)
	}
}

// The duplicate guard still catches a double registration inside one app.
func TestDuplicateRoomKindPanicsWithinOneApp(t *testing.T) {
	a := newRealtimeApp(t)
	RegisterRoomKind(a, "dup", allowAllAuth)
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic on a duplicate kind in one app")
		}
	}()
	RegisterRoomKind(a, "dup", allowAllAuth)
}

func TestBrokerIsPerApp(t *testing.T) {
	a, b := newRealtimeApp(t), newRealtimeApp(t)
	if BrokerFor(a) == BrokerFor(b) {
		t.Fatal("two apps share one broker")
	}
	if BrokerFor(a) != BrokerFor(a) {
		t.Fatal("one app got two brokers")
	}
}

// Terminating one app stops only its own broker. The broker was a process
// singleton, so the first app to terminate stopped every app's documents.
func TestTerminateStopsOnlyThatAppsBroker(t *testing.T) {
	a, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	b := newRealtimeApp(t)
	Register(a, Options{})
	Register(b, Options{})

	a.Cleanup() // runs a's terminate chain

	if !BrokerFor(a).stopping() {
		t.Fatal("app A's terminate did not stop its broker")
	}
	if BrokerFor(b).stopping() {
		t.Fatal("app A's terminate stopped app B's broker")
	}
}

// A drain that begins for one app turns away only that app's upgrades.
func TestDrainingIsPerApp(t *testing.T) {
	a, b := newRealtimeApp(t), newRealtimeApp(t)
	BrokerFor(a).beginDrain()

	if !BrokerFor(a).draining.Load() {
		t.Fatal("app A is not draining")
	}
	if BrokerFor(b).draining.Load() {
		t.Fatal("app A's drain reached app B")
	}
}

// FlushItem flushes the item's rooms in the app that asked, never in another
// app that happens to hold the same item id.
func TestFlushItemReachesOnlyThatAppsKinds(t *testing.T) {
	a, b := newRealtimeApp(t), newRealtimeApp(t)
	var flushedA, flushedB int
	RegisterRoomKindWith(a, "doc", RoomKindOptions{
		Authorize:  allowAllAuth,
		ForceFlush: func(string) error { flushedA++; return nil },
	})
	RegisterRoomKindWith(b, "doc", RoomKindOptions{
		Authorize:  allowAllAuth,
		ForceFlush: func(string) error { flushedB++; return nil },
	})

	if err := FlushItem(a, "item-1"); err != nil {
		t.Fatal(err)
	}
	if flushedA != 1 || flushedB != 0 {
		t.Fatalf("flushedA=%d flushedB=%d; want only app A's kind flushed", flushedA, flushedB)
	}
}

// A share-session resolver installed for one app does not admit anonymous
// visitors to another app's rooms.
func TestShareSessionResolverIsPerApp(t *testing.T) {
	a, b := newRealtimeApp(t), newRealtimeApp(t)
	SetShareSessionResolver(a, func(core.App, string) (ShareClaims, error) {
		return ShareClaims{AnonID: "anon-a"}, nil
	})

	claims, err := BrokerFor(a).resolveShareSession(a, "token")
	if err != nil || claims.AnonID != "anon-a" {
		t.Fatalf("app A resolved %+v, %v; want its own resolver", claims, err)
	}
	if _, err := BrokerFor(b).resolveShareSession(b, "token"); !errors.Is(err, errShareSessionUnsupported) {
		t.Fatalf("app B resolved a share session with app A's resolver: %v", err)
	}
}
