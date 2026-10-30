package realtime

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tinycld.org/core/editcheckpoint"
)

type checkpointCall struct {
	itemID  string
	editors editcheckpoint.Editors
	reason  editcheckpoint.Reason
}

// recordCheckpoints registers a listener that sends every checkpoint to the
// returned channel, and shortens the idle period for the test.
func recordCheckpoints(t *testing.T, idle time.Duration) chan checkpointCall {
	t.Helper()
	prev := idleCheckpointAfter
	idleCheckpointAfter = idle
	calls := make(chan checkpointCall, 8)
	editcheckpoint.Register(func(_ context.Context, id string, e editcheckpoint.Editors, r editcheckpoint.Reason) {
		calls <- checkpointCall{id, e, r}
	})
	t.Cleanup(func() {
		idleCheckpointAfter = prev
		editcheckpoint.ResetForTest()
	})
	return calls
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
	calls := recordCheckpoints(t, 80*time.Millisecond)
	opts := checkpointKind(t, NewBroker(), RoomKindOptions{})

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
	calls := recordCheckpoints(t, 150*time.Millisecond)
	opts := checkpointKind(t, NewBroker(), RoomKindOptions{})

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

func TestRoomEmptyCheckpointFiresOnceAndBeforeOnEmpty(t *testing.T) {
	calls := recordCheckpoints(t, time.Hour)
	var mu sync.Mutex
	var order []string
	editcheckpoint.Register(func(_ context.Context, id string, e editcheckpoint.Editors, r editcheckpoint.Reason) {
		mu.Lock()
		order = append(order, "checkpoint")
		mu.Unlock()
		calls <- checkpointCall{id, e, r}
	})
	broker := NewBroker()
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

	got := waitCheckpoint(t, calls)
	if got.reason != editcheckpoint.ReasonRoomEmpty || len(got.editors.UserIDs) != 2 {
		t.Fatalf("got %+v", got)
	}
	expectNoCheckpoint(t, calls, 200*time.Millisecond)
	deadline := time.Now().Add(2 * time.Second)
	for broker.roomCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "checkpoint" || order[1] != "on-empty" {
		t.Fatalf("order = %v, want checkpoint then on-empty", order)
	}
}

func TestShareEditorsRecordedByDisplayName(t *testing.T) {
	calls := recordCheckpoints(t, 80*time.Millisecond)
	opts := checkpointKind(t, NewBroker(), RoomKindOptions{})

	anon := dialShareClient(t, opts, "share-room", "anon-123", "Anon Otter")
	writeFrame(t, anon, MsgDocUpdate, []byte("e1"))
	got := waitCheckpoint(t, calls)
	if len(got.editors.UserIDs) != 0 || len(got.editors.ShareNames) != 1 || got.editors.ShareNames[0] != "Anon Otter" {
		t.Fatalf("editors = %+v", got.editors)
	}
}

func TestTakeEditorsClearsSetAndStopsTimer(t *testing.T) {
	calls := recordCheckpoints(t, 100*time.Millisecond)
	broker := NewBroker()
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
	calls := recordCheckpoints(t, 50*time.Millisecond)
	opts := startTestServerWithOpts(t, NewBroker(), RoomKindOptions{RuntimeProvider: newStubRuntime()})

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
