package realtime

import (
	"context"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"tinycld.org/core/editcheckpoint"
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
	fireEditCheckpoint(r.key.id, editors, editcheckpoint.ReasonIdle)
}

func fireEditCheckpoint(id string, editors editcheckpoint.Editors, reason editcheckpoint.Reason) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTeardownTimeout)
	defer cancel()
	editcheckpoint.Fire(ctx, id, editors, reason)
}

// TakeEditors returns and clears the editors of every open room for id,
// across the kinds that keep checkpoints. A manual version takes them so
// the next automatic one names only later editors.
func TakeEditors(id string) editcheckpoint.Editors {
	return sharedBroker().TakeEditors(id)
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
	return editcheckpoint.Editors{UserIDs: unique(out.UserIDs), ShareNames: unique(out.ShareNames)}
}

// unique keeps the first of each value, in order.
func unique(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(values))
	out := values[:0:0]
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// HoldEditors keeps editors for the next TakeEditors of id: a checkpoint
// listener that makes no version (for example, automatic versions are off)
// hands them back, so the next version still names them.
func HoldEditors(id string, editors editcheckpoint.Editors) {
	sharedBroker().HoldEditors(id, editors)
}

func (b *Broker) HoldEditors(id string, editors editcheckpoint.Editors) {
	if editors.Empty() {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.addHeldLocked(id, editors)
}

// addHeldLocked merges editors into the held set for id. Caller holds b.mu.
func (b *Broker) addHeldLocked(id string, editors editcheckpoint.Editors) {
	held := b.heldEditors[id]
	held.UserIDs = append(held.UserIDs, editors.UserIDs...)
	held.ShareNames = append(held.ShareNames, editors.ShareNames...)
	b.heldEditors[id] = held
}

// holdEditorsIfFenced keeps a closing room's editors for the WriteItem that
// closed it, and reports whether it did.
func (b *Broker) holdEditorsIfFenced(id string, editors editcheckpoint.Editors) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fenced[id] == 0 {
		return false
	}
	b.addHeldLocked(id, editors)
	return true
}
