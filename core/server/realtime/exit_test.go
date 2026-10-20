package realtime

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/drainhooks"
)

// exitFixture serves a kind whose rooms a SaveCoordinator saves, on a broker
// bound to a test app's terminate. The kind keeps no checkpoints unless the
// test asks for them, so the final flush is the coordinator's only way to
// store an edit.
type exitFixture struct {
	app    *tests.TestApp
	broker *Broker
	coord  *SaveCoordinator
	rt     *stubRuntime
	opts   dialOpts

	mu sync.Mutex
	// flushes records every flush in the order it started.
	flushes []exitFlush
	// terminated is set once terminate has returned; a flush that starts
	// after it ran on a closed database.
	terminated bool
	// hold, when set, blocks the next flush until it is closed; started is
	// closed as that flush begins.
	hold    chan struct{}
	started chan struct{}
}

type exitFlush struct {
	roomID          string
	state           []byte
	afterTerminated bool
}

type exitFixtureOpts struct {
	checkpoints        bool
	onDocUpdateContent OnDocUpdateContentFn
}

func newExitFixture(t *testing.T, o exitFixtureOpts) *exitFixture {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	drainhooks.ResetForTest()
	resetLifecycleForTest()
	t.Cleanup(func() {
		drainhooks.ResetForTest()
		resetLifecycleForTest()
	})
	registerLifecycle(app)

	f := &exitFixture{app: app, broker: NewBroker(), rt: newStubRuntime()}
	t.Cleanup(f.broker.Close)
	swapSharedBrokerForTest(t, f.broker)

	f.coord = newFastCoordWithFlush(t, f.flush).c
	// The tests fire saves themselves; no timer of the schedule's own may
	// run during one.
	f.coord.debounceEvery = time.Hour
	f.coord.ceilingEvery = time.Hour

	kind := RoomKindOptions{
		RuntimeProvider:    f.rt,
		OnRoomCreate:       f.coord.OnRoomCreate,
		OnDocUpdate:        f.coord.OnDocUpdate,
		OnDocUpdateContent: o.onDocUpdateContent,
		OnEmpty:            f.coord.OnRoomEmpty,
		FlushDirty:         f.coord.FlushDirty,
		ForceFlush:         f.coord.FlushNow,
	}
	if o.checkpoints {
		kind.Checkpoints = NewMemoryCheckpointStore()
		kind.Fingerprint = func(string) (string, error) { return "fp", nil }
	}
	f.opts = startTestServerWithOpts(t, f.broker, kind)
	return f
}

func (f *exitFixture) flush(_ context.Context, roomID string, handle DocHandle) error {
	state, _ := handle.EncodeStateAsUpdate()
	f.mu.Lock()
	f.flushes = append(f.flushes, exitFlush{roomID: roomID, state: state, afterTerminated: f.terminated})
	hold, started := f.hold, f.started
	f.hold, f.started = nil, nil
	f.mu.Unlock()
	if hold != nil {
		close(started)
		<-hold
	}
	return nil
}

// holdNextFlush makes the next flush block until the returned release runs.
// The returned channel closes when that flush has started.
func (f *exitFixture) holdNextFlush() (started <-chan struct{}, release func()) {
	hold, s := make(chan struct{}), make(chan struct{})
	f.mu.Lock()
	f.hold, f.started = hold, s
	f.mu.Unlock()
	var once sync.Once
	return s, func() { once.Do(func() { close(hold) }) }
}

// terminate runs the app's terminate chain, as a stop does.
func (f *exitFixture) terminate(t *testing.T) {
	t.Helper()
	err := f.app.OnTerminate().Trigger(&core.TerminateEvent{App: f.app}, func(*core.TerminateEvent) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.terminated = true
	f.mu.Unlock()
}

// terminateAsync runs terminate in a goroutine; the channel closes when it
// has returned.
func (f *exitFixture) terminateAsync(t *testing.T) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		err := f.app.OnTerminate().Trigger(&core.TerminateEvent{App: f.app}, func(*core.TerminateEvent) error { return nil })
		if err != nil {
			t.Error(err)
		}
		f.mu.Lock()
		f.terminated = true
		f.mu.Unlock()
	}()
	return done
}

func (f *exitFixture) recorded() []exitFlush {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]exitFlush(nil), f.flushes...)
}

// assertNoFlushAfterTerminate fails when a flush started once terminate had
// returned: in a real process the database was closed by then.
func (f *exitFixture) assertNoFlushAfterTerminate(t *testing.T) {
	t.Helper()
	for _, fl := range f.recorded() {
		if fl.afterTerminated {
			t.Fatalf("room %s was flushed after terminate returned", fl.roomID)
		}
	}
}

// assertFlushedBeforeTerminate fails unless a flush of roomID that started
// before terminate returned holds edit.
func (f *exitFixture) assertFlushedBeforeTerminate(t *testing.T, roomID string, edit []byte) {
	t.Helper()
	for _, fl := range f.recorded() {
		if fl.roomID == roomID && !fl.afterTerminated && bytes.Contains(fl.state, edit) {
			return
		}
	}
	t.Fatalf("no flush of room %s before terminate returned holds %q; flushes: %+v", roomID, edit, f.recorded())
}

func docFrame(payload []byte) []byte {
	frame := make([]byte, frameOverhead+len(payload))
	frame[clientIDLen] = byte(MsgDocUpdate)
	copy(frame[frameOverhead:], payload)
	return frame
}

// waitApplied waits until the server document of roomID holds edit.
func (f *exitFixture) waitApplied(t *testing.T, roomID string, edit []byte) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if d := f.rt.doc(roomID); d != nil {
			state, _ := d.EncodeStateAsUpdate()
			if bytes.Contains(state, edit) {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("room %s never applied %q", roomID, edit)
}

// waitClosed waits for ch to close: the broker's stop channel closes as the
// stop begins.
func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s never happened", what)
	}
}

// expectRunning fails when done closes within d.
func expectRunning(t *testing.T, done <-chan struct{}, d time.Duration, msg string) {
	t.Helper()
	select {
	case <-done:
		t.Fatal(msg)
	case <-time.After(d):
	}
}

// readUntilClose reads conn until it fails and reports the close it saw.
func readUntilClose(conn *websocket.Conn) <-chan error {
	out := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				out <- err
				return
			}
		}
	}()
	return out
}

// A debounce timer that fires once terminate has begun does not save: the
// database it would write closes when terminate returns.
func TestExitDebounceAfterTerminateDoesNotSave(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	c := NewClientForTest("alice")
	f.broker.RouteFrameForTest("test", "r1", c, docFrame([]byte("before")))

	f.terminate(t)

	// A route call that raced the stop marks the room dirty, and its
	// debounce fires.
	f.coord.OnDocUpdate("r1")
	f.coord.triggerSave("r1", "debounce")

	f.assertNoFlushAfterTerminate(t)
}

// The janitor stops at terminate: its goroutine is told to stop, and a pass
// that runs anyway writes nothing and closes nothing.
func TestExitStopsTheJanitor(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{checkpoints: true})
	c := NewClientForTest("alice")
	f.broker.JoinForTest("test", "r1", c)
	f.broker.LeaveForTest(c)
	if f.broker.parkedCount() != 1 {
		t.Fatalf("parked = %d; want 1", f.broker.parkedCount())
	}

	f.terminate(t)

	select {
	case <-f.broker.stop:
	default:
		t.Fatal("the janitor was not told to stop")
	}
	f.broker.EvictIdleForTest(time.Now().Add(ParkIdle + time.Second))
	if f.broker.parkedCount() != 1 {
		t.Fatal("a janitor pass after terminate evicted a parked document")
	}
}

// A save in flight when terminate begins is waited for, and the edit that
// arrived during it (queued as the coalesced resave) is flushed before
// terminate returns. A timer save that fires while terminate waits is
// refused; the final flush stores that room too.
func TestExitWaitsForAResaveInFlight(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	c1, c2 := NewClientForTest("alice"), NewClientForTest("bob")
	f.broker.RouteFrameForTest("test", "r1", c1, docFrame([]byte("first")))
	f.broker.RouteFrameForTest("test", "r2", c2, docFrame([]byte("other")))

	started, release := f.holdNextFlush()
	t.Cleanup(release)
	go f.coord.triggerSave("r1", "debounce")
	<-started
	// An edit during the save queues the resave.
	f.broker.RouteFrameForTest("test", "r1", c1, docFrame([]byte("second")))
	f.coord.triggerSave("r1", "debounce")

	done := f.terminateAsync(t)
	waitClosed(t, f.broker.stop, "the stop")
	expectRunning(t, done, 100*time.Millisecond, "terminate returned while a save was in flight")

	// A timer save of another room fires while terminate waits.
	f.coord.triggerSave("r2", "debounce")
	for _, fl := range f.recorded() {
		if fl.roomID == "r2" {
			t.Fatal("a timer save ran after terminate began")
		}
	}

	release()
	<-done
	f.assertFlushedBeforeTerminate(t, "r1", []byte("second"))
	f.assertFlushedBeforeTerminate(t, "r2", []byte("other"))
	f.assertNoFlushAfterTerminate(t)
}

// An edit that reached the server just before terminate is flushed before
// terminate returns.
func TestExitFlushesAnEditFromJustBefore(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	a := dialClient(t, f.opts, "r1", "alice")
	writeFrame(t, a, MsgDocUpdate, []byte("late edit"))
	f.waitApplied(t, "r1", []byte("late edit"))
	closed := readUntilClose(a.conn)

	f.terminate(t)

	f.assertFlushedBeforeTerminate(t, "r1", []byte("late edit"))
	<-closed
	f.assertNoFlushAfterTerminate(t)
}

// A frame the server is still routing when terminate begins finishes, and
// its edit is flushed, before terminate returns.
func TestExitWaitsForARouteInProgress(t *testing.T) {
	routing, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	f := newExitFixture(t, exitFixtureOpts{
		onDocUpdateContent: func(_ string, _ *Client, payload []byte) {
			if bytes.Equal(payload, []byte("slow")) {
				close(routing)
				<-release
			}
		},
	})
	a := dialClient(t, f.opts, "r1", "alice")
	closed := readUntilClose(a.conn)
	writeFrame(t, a, MsgDocUpdate, []byte("slow"))
	<-routing

	done := f.terminateAsync(t)
	waitClosed(t, f.broker.stop, "the stop")
	expectRunning(t, done, 100*time.Millisecond, "terminate returned while a frame was being routed")

	once.Do(func() { close(release) })
	<-done
	f.assertFlushedBeforeTerminate(t, "r1", []byte("slow"))
	<-closed
}

// Terminate closes every connection with a going-away close frame, so the
// client reconnects to the next process, and a client that answers the
// close does not wait out the cut.
func TestExitClosesConnectionsGoingAway(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	a := dialClient(t, f.opts, "r1", "alice")
	closed := readUntilClose(a.conn)

	start := time.Now()
	f.terminate(t)
	took := time.Since(start)

	select {
	case err := <-closed:
		var ce websocket.CloseError
		if !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway {
			t.Fatalf("client saw %v; want a going-away close", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("terminate did not close the connection")
	}
	if took >= time.Second {
		t.Fatalf("terminate took %s with a client that answered the close", took)
	}
	if f.broker.roomCount() != 0 {
		t.Fatal("the room is still open after terminate")
	}
}

// A client that never answers the close frame is cut, and terminate still
// returns within its bound.
func TestExitCutsAStuckClient(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	// Never read: the client does not answer the close frame.
	_ = dialClient(t, f.opts, "r1", "alice")
	waitForRoomMembers(t, f.broker, "test", "r1", 1, time.Second)

	start := time.Now()
	f.terminate(t)
	took := time.Since(start)

	if f.broker.roomCount() != 0 {
		t.Fatal("the stuck client is still in its room after terminate")
	}
	if bound := time.Second + 2*time.Second; took > bound {
		t.Fatalf("terminate took %s with a stuck client; want under %s", took, bound)
	}
}

// FlushNow is refused once terminate has begun: the stop's own flush stored
// the room, and a new save could still be writing as the database closes.
func TestExitRefusesFlushNow(t *testing.T) {
	f := newExitFixture(t, exitFixtureOpts{})
	c := NewClientForTest("alice")
	f.broker.RouteFrameForTest("test", "r1", c, docFrame([]byte("edit")))

	f.terminate(t)

	if err := f.coord.FlushNow("r1"); err == nil {
		t.Fatal("FlushNow ran after terminate")
	}
	f.assertNoFlushAfterTerminate(t)
}
