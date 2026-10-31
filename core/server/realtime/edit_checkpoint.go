package realtime

import (
	"context"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/background"
	"tinycld.org/core/editcheckpoint"
	"tinycld.org/core/logging"
)

// idleCheckpointAfter is how long a room with edits waits without a new
// edit before it fires an idle checkpoint. TINYCLD_VERSION_IDLE_MS sets it
// (the e2e config uses a few seconds); tests set it directly.
var idleCheckpointAfter = idleFromEnv()

const defaultIdleCheckpoint = 10 * time.Minute

func idleFromEnv() time.Duration {
	raw := os.Getenv("TINYCLD_VERSION_IDLE_MS")
	if raw == "" {
		return defaultIdleCheckpoint
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		log.Warn("ignoring invalid TINYCLD_VERSION_IDLE_MS", "value", raw)
		return defaultIdleCheckpoint
	}
	return time.Duration(ms) * time.Millisecond
}

// editTracker is a room's record of who edited since the last checkpoint,
// and the idle timer that fires the next one. The zero value is ready.
type editTracker struct {
	mu         sync.Mutex
	userIDs    map[string]struct{}
	shareNames map[string]struct{}
	idleTimer  *time.Timer
}

// noteEdit records the sender and restarts the idle timer. An anonymous
// share visitor has a display name and no user record.
func (e *editTracker) noteEdit(from *Client, onIdle func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if from != nil {
		if from.displayName != "" {
			if e.shareNames == nil {
				e.shareNames = map[string]struct{}{}
			}
			e.shareNames[from.displayName] = struct{}{}
		} else if from.authID != "" {
			if e.userIDs == nil {
				e.userIDs = map[string]struct{}{}
			}
			e.userIDs[from.authID] = struct{}{}
		}
	}
	if e.idleTimer != nil {
		e.idleTimer.Stop()
	}
	e.idleTimer = time.AfterFunc(idleCheckpointAfter, onIdle)
}

// take returns the editors, clears the set and stops the idle timer, so
// each edit belongs to exactly one checkpoint.
func (e *editTracker) take() editcheckpoint.Editors {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.idleTimer != nil {
		e.idleTimer.Stop()
		e.idleTimer = nil
	}
	out := editcheckpoint.Editors{UserIDs: sortedKeys(e.userIDs), ShareNames: sortedKeys(e.shareNames)}
	e.userIDs = nil
	e.shareNames = nil
	return out
}

func sortedKeys(m map[string]struct{}) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// noteEditForCheckpoint is called from the MsgDocUpdate path of a room
// whose kind opted in.
func (r *Room) noteEditForCheckpoint(from *Client) {
	r.edits.noteEdit(from, r.fireIdleCheckpoint)
}

// fireIdleCheckpoint hands the editors since the last checkpoint to the
// registered listener. An idle timer that fires while the room is tearing
// down does nothing: the room-empty checkpoint in remove covers it.
func (r *Room) fireIdleCheckpoint() {
	r.mu.Lock()
	draining := r.draining
	r.mu.Unlock()
	if draining {
		return
	}
	editors := r.edits.take()
	if editors.Empty() {
		return
	}
	fireEditCheckpoint(r.broker.app, r.key.id, editors, editcheckpoint.ReasonIdle)
}

// fireEditCheckpoint hands a checkpoint to the listener of the app whose room
// reached it. It runs on a timer goroutine or a goroutine of its own, so it
// stops a panic in the listener here, and names the app on the ctx so the
// listener's records reach that app.
func fireEditCheckpoint(app core.App, id string, editors editcheckpoint.Editors, reason editcheckpoint.Reason) {
	defer background.Recover(app, "realtime", "edit checkpoint")
	ctx, cancel := context.WithTimeout(logging.WithApp(context.Background(), app), DefaultTeardownTimeout)
	defer cancel()
	editcheckpoint.Fire(ctx, app, id, editors, reason)
}

// TakeEditors returns and clears the editors of every open room for id in
// app, across the kinds that keep checkpoints. A manual version takes them so
// the next automatic one names only later editors.
func TakeEditors(app core.App, id string) editcheckpoint.Editors {
	return BrokerFor(app).TakeEditors(id)
}

func (b *Broker) TakeEditors(id string) editcheckpoint.Editors {
	b.mu.Lock()
	out := b.heldEditors[id]
	delete(b.heldEditors, id)
	var rooms []*Room
	for key, room := range b.rooms {
		if key.id == id && room.opts.EditCheckpoints {
			rooms = append(rooms, room)
		}
	}
	b.mu.Unlock()
	for _, room := range rooms {
		e := room.edits.take()
		out.UserIDs = append(out.UserIDs, e.UserIDs...)
		out.ShareNames = append(out.ShareNames, e.ShareNames...)
	}
	return out
}

// holdEditorsIfFenced keeps a closing room's editors for the WriteItem that
// closed it, and reports whether it did.
func (b *Broker) holdEditorsIfFenced(id string, editors editcheckpoint.Editors) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fenced[id] == 0 {
		return false
	}
	held := b.heldEditors[id]
	held.UserIDs = append(held.UserIDs, editors.UserIDs...)
	held.ShareNames = append(held.ShareNames, editors.ShareNames...)
	b.heldEditors[id] = held
	return true
}
