package realtime

import "errors"

// ErrItemOpen reports that an editor room has clients for the item, so a
// write from outside the room would be overwritten by the room's next save.
var ErrItemOpen = errors.New("realtime: item is open in an editor")

// WriteItem runs write, which replaces the stored source of id from outside
// any room (an upload, a restore, a WebDAV PUT), only while no room of any
// kind has clients for id. New joins wait until write returns. A successful
// write then drops every kind's parked document and checkpoint for id while
// joins still wait: the parked state predates the write, and Suspend would
// checkpoint it under the new file's fingerprint, so the next open would
// save the old content over the write. The next room seeds from the file.
func WriteItem(id string, write func() error) error {
	return sharedBroker().WriteItem(id, write)
}

func (b *Broker) WriteItem(id string, write func() error) error {
	b.mu.Lock()
	for key := range b.rooms {
		if key.id == id {
			b.mu.Unlock()
			return ErrItemOpen
		}
	}
	b.fenced[id]++
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		if b.fenced[id]--; b.fenced[id] == 0 {
			delete(b.fenced, id)
		}
		b.mu.Unlock()
	}()
	if err := write(); err != nil {
		return err
	}
	for _, kind := range registeredKinds() {
		if err := b.DropRoom(kind, id); err != nil {
			log.Warn("parked document not dropped after an external write",
				"kind", kind, "roomID", id, "err", err)
		}
	}
	return nil
}

// JoinItemForTest puts a test client in the shared broker's room (kind, id)
// so a package test can hold an item open. Production code must not call
// this.
func JoinItemForTest(kind, id string) (leave func()) {
	b := sharedBroker()
	c := NewClientForTest("test-" + id)
	b.JoinForTest(kind, id, c)
	return func() { b.LeaveForTest(c) }
}
