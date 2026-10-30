package realtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// An open editor does not block an outside write: the write closes the
// item's connections, waits for the room to go, and then runs.
func TestWriteItem_ClosesTheOpenConnectionsThenWrites(t *testing.T) {
	broker := NewBroker()
	t.Cleanup(broker.Close)
	opts := startTestServer(t, broker, allowAllAuth)
	a := dialClient(t, opts, "room-w", "alice")
	waitForRoomMembers(t, broker, "test", "room-w", 1, time.Second)
	// A browser reads all the time, so it answers the close handshake.
	closed := make(chan error, 1)
	go func() {
		_, _, err := a.conn.Read(context.Background())
		closed <- err
	}()

	roomOpenAtWrite := true
	err := broker.WriteItem("room-w", func() error {
		roomOpenAtWrite = broker.lookupRoomForTest("test", "room-w") != nil
		return nil
	})

	if err != nil {
		t.Fatal(err)
	}
	if roomOpenAtWrite {
		t.Fatal("the write ran while the room was still open")
	}
	var ce websocket.CloseError
	if err := <-closed; !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway {
		t.Fatalf("client read ended with %v; want a going-away close", err)
	}
}

// The room's final save runs before the write, so the write replaces a file
// that holds the editors' last edits, and an archive of it keeps them.
func TestWriteItem_TheRoomSavesBeforeTheWrite(t *testing.T) {
	f := newOpenFixture(t, "write-saves-first", NewMemoryCheckpointStore())
	f.broker.JoinForTest(f.kind, "r1", NewClientForTest("u1"))

	emptiesAtWrite := 0
	err := f.broker.WriteItem("r1", func() error {
		f.dirtyMu.Lock()
		defer f.dirtyMu.Unlock()
		emptiesAtWrite = f.empties
		return nil
	})

	if err != nil {
		t.Fatal(err)
	}
	if emptiesAtWrite != 1 {
		t.Fatalf("OnEmpty ran %d times before the write; want 1", emptiesAtWrite)
	}
}

// A room that does not close in time fails the write, and the fence lifts
// so the item can open again.
func TestWriteItem_FailsWhenTheRoomDoesNotClose(t *testing.T) {
	b := NewBroker()
	t.Cleanup(b.Close)
	swapCloseRoomsTimeoutForTest(t, 50*time.Millisecond)
	stuck := &Client{evict: func() {}}
	b.join("write-test-stuck", "item1", stuck)

	called := false
	err := b.WriteItem("item1", func() error { called = true; return nil })

	if !errors.Is(err, ErrItemBusy) {
		t.Fatalf("err = %v, want ErrItemBusy", err)
	}
	if called {
		t.Fatal("write ran while the room was still open")
	}
	joined := make(chan struct{})
	go func() { b.JoinForTest("write-test-stuck", "item1", NewClientForTest("u2")); close(joined) }()
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("the fence stayed up after the failed write")
	}
}

func TestWriteItem_RunsWhenNoRoomIsOpen(t *testing.T) {
	b := NewBroker()
	t.Cleanup(b.Close)
	called := false
	if err := b.WriteItem("item1", func() error { called = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("write did not run")
	}
}

func TestWriteItem_ReturnsTheWriteError(t *testing.T) {
	b := NewBroker()
	t.Cleanup(b.Close)
	boom := errors.New("boom")
	if err := b.WriteItem("item1", func() error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}

// A join that arrives during the write waits for it, so the room seeds from
// the new file and not the one the write replaces.
func TestWriteItem_JoinWaitsForTheWrite(t *testing.T) {
	b := NewBroker()
	t.Cleanup(b.Close)
	release := make(chan struct{})
	writing := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- b.WriteItem("item1", func() error { close(writing); <-release; return nil })
	}()
	<-writing

	joined := make(chan struct{})
	go func() { b.JoinForTest("write-test-wait", "item1", NewClientForTest("u1")); close(joined) }()

	select {
	case <-joined:
		t.Fatal("join completed while the write held the fence")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("join never completed after the write")
	}
}

// A JoinItemForTest client leaves when a write closes the room, and its
// own leave afterwards is harmless.
func TestJoinItemForTest_LeavesWhenAWriteClosesTheRoom(t *testing.T) {
	leave := JoinItemForTest("write-test-shared", "item-shared")
	if err := WriteItem("item-shared", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	leave()
}

// A parked document still holds the state from before the write. Suspend
// would checkpoint that state under the new file's fingerprint, and the
// next open would then save the old content over the write; so a write
// drops the parked document and its checkpoint, and the next open seeds
// from the new file.
func TestWriteItem_DropsTheParkedDocumentAndCheckpoint(t *testing.T) {
	store := NewMemoryCheckpointStore()
	f := newOpenFixture(t, "write-parked", store)
	room, c := f.open("r1")
	handle := room.serverDoc.(*ycrdtHandle)
	room.remove(c)
	_ = store.Save(f.kind, "r1", Checkpoint{Epoch: 1, Fingerprint: "fp-1", State: []byte{1}})

	if err := f.broker.WriteItem("r1", func() error { return nil }); err != nil {
		t.Fatal(err)
	}

	if f.broker.parkedCount() != 0 || !handle.isClosed() {
		t.Fatal("the parked document survived the write")
	}
	if _, found, _ := store.Load(f.kind, "r1"); found {
		t.Fatal("the checkpoint survived the write")
	}
}

// A failed write changed nothing, so the parked document stays.
func TestWriteItem_KeepsTheParkedDocumentWhenTheWriteFails(t *testing.T) {
	f := newOpenFixture(t, "write-parked-fail", NewMemoryCheckpointStore())
	room, c := f.open("r1")
	room.remove(c)

	boom := errors.New("boom")
	if err := f.broker.WriteItem("r1", func() error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if f.broker.parkedCount() != 1 {
		t.Fatal("a failed write dropped the parked document")
	}
}

func swapCloseRoomsTimeoutForTest(t *testing.T, d time.Duration) {
	prev := closeRoomsTimeout
	closeRoomsTimeout = d
	t.Cleanup(func() { closeRoomsTimeout = prev })
}
