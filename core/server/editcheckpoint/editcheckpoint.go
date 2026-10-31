// Package editcheckpoint carries "a document reached a checkpoint" from the
// realtime rooms to whatever keeps versions. Core does not know who
// listens; the package that owns versions registers itself.
package editcheckpoint

import (
	"context"
	"sync"
)

// Editors are the people who changed the document since the last
// checkpoint. Anonymous share-link editors have no user record, so only
// their display name is kept.
type Editors struct {
	UserIDs    []string
	ShareNames []string
}

// Empty reports whether nobody edited.
func (e Editors) Empty() bool { return len(e.UserIDs) == 0 && len(e.ShareNames) == 0 }

// Reason says why the checkpoint fired.
type Reason string

const (
	// ReasonIdle: no edits for the idle period after an edit.
	ReasonIdle Reason = "idle"
	// ReasonRoomEmpty: the last client left the document.
	ReasonRoomEmpty Reason = "room-empty"
)

// Listener receives a checkpoint. It runs synchronously in the caller.
type Listener func(ctx context.Context, itemID string, editors Editors, reason Reason)

var (
	mu       sync.RWMutex
	listener Listener
)

// Register sets the one listener. A later call replaces it.
func Register(fn Listener) {
	mu.Lock()
	defer mu.Unlock()
	listener = fn
}

// Fire hands a checkpoint to the listener. No listener: no-op.
func Fire(ctx context.Context, itemID string, editors Editors, reason Reason) {
	mu.RLock()
	fn := listener
	mu.RUnlock()
	if fn != nil {
		fn(ctx, itemID, editors, reason)
	}
}

// ResetForTest removes the listener. Tests only.
func ResetForTest() {
	mu.Lock()
	defer mu.Unlock()
	listener = nil
}
