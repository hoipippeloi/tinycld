package realtime

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/editcheckpoint"
	"tinycld.org/core/logging"
)

type checkpointCall struct {
	itemID  string
	editors editcheckpoint.Editors
	reason  editcheckpoint.Reason
}

// recordCheckpoints returns a broker that serves a fresh app whose listener
// sends every checkpoint to the returned channel, and shortens the idle period
// for the test.
func recordCheckpoints(t *testing.T, idle time.Duration) (chan checkpointCall, *Broker) {
	t.Helper()
	prev := idleCheckpointAfter
	idleCheckpointAfter = idle
	t.Cleanup(func() { idleCheckpointAfter = prev })
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	broker := NewBroker()
	attachBrokerForTest(app, broker)
	calls := make(chan checkpointCall, 8)
	editcheckpoint.Register(app, func(_ context.Context, id string, e editcheckpoint.Editors, r editcheckpoint.Reason) {
		calls <- checkpointCall{id, e, r}
	})
	return calls, broker
}

func waitCheckpoint(t *testing.T, calls chan checkpointCall) checkpointCall {
	t.Helper()
	select {
	case c := <-calls:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("no checkpoint fired")
		return checkpointCall{}
	}
}

func expectNoCheckpoint(t *testing.T, calls chan checkpointCall, d time.Duration) {
	t.Helper()
	select {
	case c := <-calls:
		t.Fatalf("unexpected checkpoint: %+v", c)
	case <-time.After(d):
	}
}

func dialShareClient(t *testing.T, opts dialOpts, roomID, anonID, name string) *testClient {
	t.Helper()
	hdr := http.Header{}
	hdr.Set("X-Test-User", anonID)
	hdr.Set("X-Test-Display-Name", name)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, opts.url+roomID, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "test done") })
	readCtx, rcancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer rcancel()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read assign frame failed: %v", err)
	}
	tc := &testClient{conn: conn}
	copy(tc.id[:], data[:clientIDLen])
	return tc
}

func checkpointKind(t *testing.T, broker *Broker, opts RoomKindOptions) dialOpts {
	t.Helper()
	opts.RuntimeProvider = newStubRuntime()
	opts.EditCheckpoints = true
	return startTestServerWithOpts(t, broker, opts)
}

func TestIdleCheckpointFiresAfterEditsOnly(t *testing.T) {
	calls, broker := recordCheckpoints(t, 80*time.Millisecond)
	opts := checkpointKind(t, broker, RoomKindOptions{})

	a := dialClient(t, opts, "idle-room", "alice")
	expectNoCheckpoint(t, calls, 200*time.Millisecond)

	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	writeFrame(t, a, MsgDocUpdate, []byte("e2"))
	got := waitCheckpoint(t, calls)
	if got.itemID != "idle-room" || got.reason != editcheckpoint.ReasonIdle {
		t.Fatalf("got %+v", got)
	}
	if len(got.editors.UserIDs) != 1 || got.editors.UserIDs[0] != "alice" {
		t.Fatalf("editors = %+v", got.editors)
	}
	expectNoCheckpoint(t, calls, 200*time.Millisecond)
}

func TestIdleTimerResetsOnEachEdit(t *testing.T) {
	calls, broker := recordCheckpoints(t, 150*time.Millisecond)
	opts := checkpointKind(t, broker, RoomKindOptions{})

	a := dialClient(t, opts, "reset-room", "alice")
	start := time.Now()
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	time.Sleep(100 * time.Millisecond)
	writeFrame(t, a, MsgDocUpdate, []byte("e2"))
	waitCheckpoint(t, calls)
	if elapsed := time.Since(start); elapsed < 240*time.Millisecond {
		t.Fatalf("checkpoint after %v; the second edit should have reset the timer", elapsed)
	}
	expectNoCheckpoint(t, calls, 250*time.Millisecond)
}

// The room-empty checkpoint runs after OnEmpty (the kind's final save has
// written the file) and off the teardown path, so a slow version save does
// not hold the room key and block a rejoin.
func TestRoomEmptyCheckpointFiresOnceAfterOnEmptyWithoutBlocking(t *testing.T) {
	calls, broker := recordCheckpoints(t, time.Hour)
	release := make(chan struct{})
	var mu sync.Mutex
	var order []string
	editcheckpoint.Register(broker.app, func(_ context.Context, id string, e editcheckpoint.Editors, r editcheckpoint.Reason) {
		mu.Lock()
		order = append(order, "checkpoint")
		mu.Unlock()
		<-release
		calls <- checkpointCall{id, e, r}
	})
	opts := checkpointKind(t, broker, RoomKindOptions{
		OnEmpty: func(string) {
			mu.Lock()
			order = append(order, "on-empty")
			mu.Unlock()
		},
	})

	a := dialClient(t, opts, "empty-room", "alice")
	b := dialClient(t, opts, "empty-room", "bob")
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	writeFrame(t, b, MsgDocUpdate, []byte("e2"))
	time.Sleep(50 * time.Millisecond)
	_ = a.conn.Close(websocket.StatusNormalClosure, "bye")
	_ = b.conn.Close(websocket.StatusNormalClosure, "bye")

	// The listener is still blocked, yet the room is gone.
	deadline := time.Now().Add(2 * time.Second)
	for broker.roomCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := broker.roomCount(); n != 0 {
		t.Fatalf("room still open while the checkpoint listener runs (%d rooms)", n)
	}
	close(release)

	got := waitCheckpoint(t, calls)
	if got.reason != editcheckpoint.ReasonRoomEmpty || len(got.editors.UserIDs) != 2 {
		t.Fatalf("got %+v", got)
	}
	expectNoCheckpoint(t, calls, 200*time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "on-empty" || order[1] != "checkpoint" {
		t.Fatalf("order = %v, want on-empty then checkpoint", order)
	}
}

func TestShareEditorsRecordedByDisplayName(t *testing.T) {
	calls, broker := recordCheckpoints(t, 80*time.Millisecond)
	opts := checkpointKind(t, broker, RoomKindOptions{})

	anon := dialShareClient(t, opts, "share-room", "anon-123", "Anon Otter")
	writeFrame(t, anon, MsgDocUpdate, []byte("e1"))
	got := waitCheckpoint(t, calls)
	if len(got.editors.UserIDs) != 0 || len(got.editors.ShareNames) != 1 || got.editors.ShareNames[0] != "Anon Otter" {
		t.Fatalf("editors = %+v", got.editors)
	}
}

func TestTakeEditorsClearsSetAndStopsTimer(t *testing.T) {
	calls, broker := recordCheckpoints(t, 100*time.Millisecond)
	opts := checkpointKind(t, broker, RoomKindOptions{})

	a := dialClient(t, opts, "take-room", "alice")
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	time.Sleep(30 * time.Millisecond)

	got := broker.TakeEditors("take-room")
	if len(got.UserIDs) != 1 || got.UserIDs[0] != "alice" {
		t.Fatalf("TakeEditors = %+v", got)
	}
	expectNoCheckpoint(t, calls, 250*time.Millisecond)
	if again := broker.TakeEditors("take-room"); !again.Empty() {
		t.Fatalf("second TakeEditors = %+v, want empty", again)
	}
}

func TestKindWithoutEditCheckpointsNeverFires(t *testing.T) {
	calls, broker := recordCheckpoints(t, 50*time.Millisecond)
	opts := startTestServerWithOpts(t, broker, RoomKindOptions{RuntimeProvider: newStubRuntime()})

	a := dialClient(t, opts, "plain-room", "alice")
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	expectNoCheckpoint(t, calls, 200*time.Millisecond)
	_ = a.conn.Close(websocket.StatusNormalClosure, "bye")
	expectNoCheckpoint(t, calls, 200*time.Millisecond)
}

func TestIdleFromEnv(t *testing.T) {
	cases := map[string]time.Duration{
		"2000": 2 * time.Second,
		"":     10 * time.Minute,
		"x":    10 * time.Minute,
		"-1":   10 * time.Minute,
	}
	for value, want := range cases {
		t.Setenv("TINYCLD_VERSION_IDLE_MS", value)
		if got := idleFromEnv(); got != want {
			t.Errorf("idleFromEnv(%q) = %v, want %v", value, got, want)
		}
	}
}

// During a drain the database closes after the rooms; the room-empty
// version is skipped (the edits are saved by OnEmpty).
func TestRoomEmptyCheckpointSkippedDuringDrain(t *testing.T) {
	calls, broker := recordCheckpoints(t, time.Hour)
	opts := checkpointKind(t, broker, RoomKindOptions{})
	a := dialClient(t, opts, "drain-room", "alice")
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	time.Sleep(50 * time.Millisecond)

	broker.draining.Store(true)
	_ = a.conn.Close(websocket.StatusNormalClosure, "bye")
	expectNoCheckpoint(t, calls, 300*time.Millisecond)
}

// An outside write (WriteItem: upload, restore) closes the item's rooms.
// Their editors made the state the write replaces, so they are held for the
// writer (TakeEditors inside write), not fired as a room-empty checkpoint
// that would race the write and could copy the new file.
func TestWriteItemHandsTheEditorsToTheWriter(t *testing.T) {
	calls, broker := recordCheckpoints(t, time.Hour)
	t.Cleanup(broker.Close)
	opts := checkpointKind(t, broker, RoomKindOptions{})
	a := dialClient(t, opts, "write-room", "alice")
	go func() { _, _, _ = a.conn.Read(context.Background()) }()
	writeFrame(t, a, MsgDocUpdate, []byte("e1"))
	time.Sleep(50 * time.Millisecond)

	var taken editcheckpoint.Editors
	if err := broker.WriteItem("write-room", func() error {
		taken = broker.TakeEditors("write-room")
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if len(taken.UserIDs) != 1 || taken.UserIDs[0] != "alice" {
		t.Fatalf("editors taken in the write = %+v, want [alice]", taken)
	}
	expectNoCheckpoint(t, calls, 300*time.Millisecond)
	if left := broker.TakeEditors("write-room"); !left.Empty() {
		t.Fatalf("editors left after the write = %+v", left)
	}
}

// A checkpoint runs on a timer goroutine or a goroutine of its own, where a
// panic in the package's listener that nothing stops ends the process and
// every app it runs.
func TestCheckpointListenerPanicIsRecovered(t *testing.T) {
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	editcheckpoint.Register(app, func(context.Context, string, editcheckpoint.Editors, editcheckpoint.Reason) {
		panic("listener bug")
	})

	fireEditCheckpoint(app, "item1", editcheckpoint.Editors{UserIDs: []string{"u1"}}, editcheckpoint.ReasonIdle)
}

// The listener logs and captures with the ctx it gets, so that ctx must name
// the app, or its records reach no app's _logs table and no app's Sentry hub.
func TestCheckpointListenerCtxNamesTheApp(t *testing.T) {
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	var got core.App
	editcheckpoint.Register(app, func(ctx context.Context, _ string, _ editcheckpoint.Editors, _ editcheckpoint.Reason) {
		got, _ = logging.AppFrom(ctx)
	})

	fireEditCheckpoint(app, "item1", editcheckpoint.Editors{UserIDs: []string{"u1"}}, editcheckpoint.ReasonIdle)

	if got != core.App(app) {
		t.Fatalf("listener ctx names app %v, want the room's app", got)
	}
}

// A checkpoint that makes no version (automatic versions off) hands its
// editors back; the next version taken with TakeEditors names them.
func TestHoldEditorsKeepsThemForTheNextTake(t *testing.T) {
	broker := NewBroker()
	t.Cleanup(broker.Close)
	broker.HoldEditors("held-room", editcheckpoint.Editors{UserIDs: []string{"alice"}, ShareNames: []string{"Anon Otter"}})
	broker.HoldEditors("held-room", editcheckpoint.Editors{UserIDs: []string{"alice", "bob"}})

	got := broker.TakeEditors("held-room")
	if len(got.UserIDs) != 2 || got.UserIDs[0] != "alice" || got.UserIDs[1] != "bob" {
		t.Fatalf("UserIDs = %v, want [alice bob] (deduplicated)", got.UserIDs)
	}
	if len(got.ShareNames) != 1 || got.ShareNames[0] != "Anon Otter" {
		t.Fatalf("ShareNames = %v", got.ShareNames)
	}
	if again := broker.TakeEditors("held-room"); !again.Empty() {
		t.Fatalf("second take = %+v, want empty", again)
	}
}
