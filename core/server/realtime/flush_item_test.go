package realtime

import (
	"errors"
	"testing"
)

// FlushItem asks every kind that persists rooms to flush the id, and a kind
// without ForceFlush is skipped rather than failing the call.
func TestFlushItemCallsEveryKindWithForceFlush(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	var flushedA, flushedB []string
	RegisterRoomKindWith("kind-a", RoomKindOptions{
		Authorize:  allowAllAuth,
		ForceFlush: func(id string) error { flushedA = append(flushedA, id); return nil },
	})
	RegisterRoomKindWith("kind-b", RoomKindOptions{
		Authorize:  allowAllAuth,
		ForceFlush: func(id string) error { flushedB = append(flushedB, id); return nil },
	})
	RegisterRoomKindWith("kind-no-persist", RoomKindOptions{Authorize: allowAllAuth})

	if err := FlushItem("item-1"); err != nil {
		t.Fatalf("FlushItem = %v; want nil", err)
	}
	if len(flushedA) != 1 || flushedA[0] != "item-1" {
		t.Fatalf("kind-a flushed %v; want [item-1]", flushedA)
	}
	if len(flushedB) != 1 || flushedB[0] != "item-1" {
		t.Fatalf("kind-b flushed %v; want [item-1]", flushedB)
	}
}

// A flush error stops the call and is returned wrapped, so a caller that
// checks errors.Is(err, ErrReadOnly) still sees it.
func TestFlushItemPropagatesTheFlushError(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	RegisterRoomKindWith("kind-ro", RoomKindOptions{
		Authorize:  allowAllAuth,
		ForceFlush: func(string) error { return ErrReadOnly },
	})

	err := FlushItem("item-1")
	if !errors.Is(err, ErrReadOnly) {
		t.Fatalf("FlushItem = %v; want ErrReadOnly", err)
	}
}

// No registered kind at all is a no-op success: the file is already current.
func TestFlushItemWithNoKindsIsNoop(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	if err := FlushItem("item-1"); err != nil {
		t.Fatalf("FlushItem = %v; want nil", err)
	}
}
