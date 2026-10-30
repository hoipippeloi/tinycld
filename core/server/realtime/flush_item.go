package realtime

import "fmt"

// FlushItem persists the live state of every room open for id, across all
// registered room kinds, and returns once each write has landed. A kind
// with no room for id has nothing to flush and reports success, so the
// caller needs no map from item to kind.
//
// A package that serves, copies, exports or snapshots a stored file calls
// this first: a room-backed document's file trails the room by up to the
// save debounce, and the reader must see the edits the editor shows.
//
// ErrReadOnly and ErrStopping propagate unchanged so the caller can refuse
// to serve a file it could not bring current.
func FlushItem(id string) error {
	for _, kind := range registeredKinds() {
		opts, err := optionsFor(kind)
		if err != nil || opts.ForceFlush == nil {
			continue
		}
		if err := opts.ForceFlush(id); err != nil {
			return fmt.Errorf("realtime: flush %s/%s: %w", kind, id, err)
		}
	}
	return nil
}
