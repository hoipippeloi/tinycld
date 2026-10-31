// Package editcheckpoint carries "a document reached a checkpoint" from the
// realtime rooms to whatever keeps versions. Core does not know who
// listens; the package that owns versions registers itself.
package editcheckpoint

import (
	"context"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
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

// listenerKey holds each app's listener. A listener versions documents in
// its own app's database, so a checkpoint must reach only the listener of the
// app whose room fired it.
var listenerKey = appstate.NewKey[Listener]("editcheckpoint.listener")

// Register sets app's one listener. A later call for the same app replaces it.
func Register(app core.App, fn Listener) {
	listenerKey.Set(app, fn)
}

// Fire hands a checkpoint to app's listener. No app or no listener: no-op.
func Fire(ctx context.Context, app core.App, itemID string, editors Editors, reason Reason) {
	if app == nil {
		return
	}
	if fn := listenerKey.Get(app); fn != nil {
		fn(ctx, itemID, editors, reason)
	}
}
