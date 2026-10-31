package realtime

import (
	"context"
	"fmt"
	"runtime/debug"
)

// recoverGoroutine ends a panic in one of the broker's goroutines and logs
// it. Defer it first in the goroutine. Room hooks and checkpoint functions
// are package code; a panic in them that no recover stops ends the process
// and every app it runs. attrs are extra log key/value pairs.
func recoverGoroutine(what string, attrs ...any) {
	r := recover()
	if r == nil {
		return
	}
	args := append([]any{"goroutine", what, "panic", fmt.Sprint(r), "stack", string(debug.Stack())}, attrs...)
	log.Error("realtime goroutine panicked", args...)
}

// safeFlush runs the kind's flush and turns a panic into an error. Flushes
// run on timer goroutines and on goroutines of their own, where a panic
// would end the process. As an error it takes the normal path: the room
// stays dirty, the in-flight slot is released, and the retry schedule runs.
func (c *SaveCoordinator) safeFlush(ctx context.Context, driveItemID string, handle DocHandle) (err error) {
	defer func() {
		if r := recover(); r != nil {
			c.logger.Error("save panicked", "driveItemID", driveItemID, "kind", c.kind,
				"panic", fmt.Sprint(r), "stack", string(debug.Stack()))
			err = fmt.Errorf("realtime: save of %s panicked: %v", driveItemID, r)
		}
	}()
	return c.flush(ctx, driveItemID, handle)
}
