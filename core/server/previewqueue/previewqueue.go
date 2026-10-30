// Package previewqueue is a tiny in-process handoff between the synchronous
// flush path (which computes the text region, hashes, and a PageModel while it
// still holds the live document state) and the asynchronous PocketBase hook
// that actually renders and persists the preview.
//
// Why this exists (and is its own package): the flush path can't render the
// JPEG inline without blocking the request, and the async hook fires later
// with only the item ID in hand — by then the live state may be gone. The
// flush path stashes the precomputed Payload here keyed by item ID; the hook
// Takes it when it runs.
//
// Self-clearing rationale: Take deletes the entry as it reads it, so a stashed
// payload is consumed exactly once and never accumulates. A payload that is
// stashed but whose hook never fires is overwritten by the next Stash for the
// same item, so the map stays bounded without a separate eviction sweep.
package previewqueue

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/appstate"
	"tinycld.org/core/thumbnails/textpreview"
)

// Payload is the precomputed preview data handed from the flush path to the
// async render hook.
type Payload struct {
	Plaintext  string
	RegionHash string
	IndexHash  string
	Page       textpreview.PageModel
}

// queue holds one app's stashed payloads. It lives on the app: item ids are
// unique only in their app, so a process-wide map could hand one app's
// render hook another app's payload.
type queue struct {
	mu    sync.Mutex
	items map[string]Payload
}

var queueKey = appstate.NewKey[*queue]("previewqueue.items")

func queueFor(app core.App) *queue {
	return queueKey.GetOrInit(app, func() *queue { return &queue{items: map[string]Payload{}} })
}

// Stash records p for itemID in app, replacing any prior unread payload.
func Stash(app core.App, itemID string, p Payload) {
	q := queueFor(app)
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items[itemID] = p
}

// Take returns the payload stashed for itemID in app and removes it, so each
// stashed payload is consumed exactly once. The bool reports whether one was
// present.
func Take(app core.App, itemID string) (Payload, bool) {
	q := queueFor(app)
	q.mu.Lock()
	defer q.mu.Unlock()
	p, ok := q.items[itemID]
	delete(q.items, itemID)
	return p, ok
}
