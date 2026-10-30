package realtime

import (
	"errors"
	"testing"
	"time"
)

func TestWriteItem_RefusesWhileARoomHasClients(t *testing.T) {
	b := NewBroker()
	t.Cleanup(b.Close)
	b.JoinForTest("write-test-open", "item1", NewClientForTest("u1"))

	called := false
	err := b.WriteItem("item1", func() error { called = true; return nil })

	if !errors.Is(err, ErrItemOpen) {
		t.Fatalf("err = %v, want ErrItemOpen", err)
	}
	if called {
		t.Fatal("write ran while the item was open")
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

// JoinItemForTest holds the item open on the shared broker until leave.
func TestJoinItemForTest_HoldsTheItemOpenUntilLeave(t *testing.T) {
	leave := JoinItemForTest("write-test-shared", "item-shared")
	if err := WriteItem("item-shared", func() error { return nil }); !errors.Is(err, ErrItemOpen) {
		t.Fatalf("err = %v, want ErrItemOpen while joined", err)
	}
	leave()
	deadline := time.Now().Add(time.Second)
	for {
		err := WriteItem("item-shared", func() error { return nil })
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("still refused after leave: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
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
