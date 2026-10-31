package realtime

import (
	"errors"
	"github.com/pocketbase/pocketbase/core"
	"time"
)

// ErrItemBusy reports that a room for the item did not close in time, so
// an outside write did not run.
var ErrItemBusy = errors.New("realtime: the item's editors did not close in time")

// closeRoomsTimeout bounds the wait for an item's rooms to close. Each
// room's final save is capped at DefaultTeardownTimeout.
var closeRoomsTimeout = DefaultTeardownTimeout + 5*time.Second

// replacedCloseReason tells a client why its connection closed; it
// reconnects and loads the new file.
const replacedCloseReason = "file replaced; reconnect"

// WriteItem runs write, which replaces the stored source of id from outside
// any room (an upload, a restore, a WebDAV PUT). The write wins over open
// editors: new joins wait, every room of any kind for id closes its
// connections and runs its final save, and only then does write run, so it
// replaces a file that holds the editors' last edits. The clients reconnect
// to a room seeded from the new file under a new epoch, and discard their
// local state.
//
// A successful write then drops every kind's parked document and
// checkpoint for id while joins still wait: the parked state predates the
// write, and Suspend would checkpoint it under the new file's fingerprint,
// so the next open would save the old content over the write.
//
// write must load the item again: the final save changes its record.
func WriteItem(app core.App, id string, write func() error) error {
	return BrokerFor(app).WriteItem(id, write)
}

func (b *Broker) WriteItem(id string, write func() error) error {
	b.mu.Lock()
	b.fenced[id]++
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		if b.fenced[id]--; b.fenced[id] == 0 {
			delete(b.fenced, id)
			// Editors the write did not take: the write replaced their
			// state, so no later version is theirs.
			delete(b.heldEditors, id)
		}
		b.mu.Unlock()
	}()
	if err := b.closeRooms(id); err != nil {
		return err
	}
	if err := write(); err != nil {
		return err
	}
	for _, kind := range b.registeredKinds() {
		if err := b.DropRoom(kind, id); err != nil {
			log.Warn("parked document not dropped after an external write",
				"kind", kind, "roomID", id, "err", err)
		}
	}
	return nil
}

// closeRooms evicts the members of every room for id and waits until the
// rooms are gone. The caller holds the fence, so no member joins meanwhile.
func (b *Broker) closeRooms(id string) error {
	deadline := time.Now().Add(closeRoomsTimeout)
	evicted := map[*Client]bool{}
	for {
		b.mu.Lock()
		var rooms []*Room
		for key, room := range b.rooms {
			if key.id == id {
				rooms = append(rooms, room)
			}
		}
		b.mu.Unlock()
		if len(rooms) == 0 {
			return nil
		}
		for _, room := range rooms {
			for _, c := range room.membersSnapshot() {
				if !evicted[c] && c.evict != nil {
					evicted[c] = true
					c.evict()
				}
			}
		}
		if time.Now().After(deadline) {
			log.Warn("rooms did not close for an external write", "roomID", id)
			return ErrItemBusy
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// JoinItemForTest puts a test client in app's room (kind, id) so a package
// test can hold an item open. Production code must not call this.
func JoinItemForTest(app core.App, kind, id string) (leave func()) {
	b := BrokerFor(app)
	c := NewClientForTest("test-" + id)
	b.JoinForTest(kind, id, c)
	return func() { b.LeaveForTest(c) }
}
