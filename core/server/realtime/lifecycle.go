package realtime

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"

	"tinycld.org/core/drainhooks"
	"tinycld.org/core/readonly"
	"tinycld.org/core/shutdown"
)

// Document edits arrive as websocket frames, not HTTP requests, so the
// server's lifecycle events reach the broker only through these hooks:
//
//   - read-only enter: Suspend, so the pause's backup or the next build's
//     migration sees every flushed file and the state of every document.
//     Sockets stay open; edits made during the pause live in the open
//     rooms and in the clients, which resend them to whichever process
//     serves them next.
//   - drain begin: Suspend (unless read-only already did), then close every
//     connection with a going-away code. Accepting has already stopped, so
//     a client's reconnect reaches the next process, whose hello carries
//     the same epoch and whose sync accepts the client's diff.
//   - terminate: Broker.Stop. It fences the broker, closes every connection
//     and waits for the saves in flight, then runs the final Suspend; after it
//     returns nothing in the broker touches the database, which the
//     terminate chain's finalizer closes next.
//
// A drain's Suspend is bounded: drainhooks.RunBegin runs inside the HTTP
// drain budget, so the flushes get suspendBudget and no more. The stop gets
// the same budget for its waits and final pass together, cut shorter by the
// terminate's shared deadline (tinycld.org/core/shutdown) when less is left.

const (
	suspendBudget      = 10 * time.Second
	readOnlySuspendMax = 15 * time.Second
	drainCloseReason   = "server restarting; reconnect"
	// realtimeSuspendPriority runs the terminate hook ahead of the drain's
	// shutdown (coreserver's drainShutdownPriority, -10000), so a plain stop
	// stores every document before PocketBase cuts request contexts. It is
	// second in the chain, after only a package operation's stop, so the
	// saves in flight get their share of the shared deadline before every
	// wait that is cheaper to cut. Like every handler it runs before the
	// chain's finalizer, which closes the database.
	realtimeSuspendPriority = -10001
)

// registerLifecycle binds the hooks above for app's broker b. Register runs it
// once per broker; read-only and drain hooks register per app, and the
// terminate hook stops only b.
func registerLifecycle(app core.App, b *Broker) {
	readonly.OnEnter(app, func() {
		ctx, cancel := context.WithTimeout(context.Background(), readOnlySuspendMax)
		defer cancel()
		b.Suspend(ctx, "read-only")
	})
	drainhooks.OnBegin(app, "realtime-rooms", b.beginDrain)
	shutdown.Register(app)
	app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
		Id:       "tinycldRealtimeSuspend",
		Priority: realtimeSuspendPriority,
		Func: func(e *core.TerminateEvent) error {
			b.Stop(shutdown.Context(app), "terminate")
			return e.Next()
		},
	})
}

// beginDrain turns away new upgrades, stores every document, and closes every
// connection of b's app.
func (b *Broker) beginDrain() {
	b.draining.Store(true)
	b.suspendForExit("drain")
	b.closeAllConns()
}

// suspendForExit stores every document unless b's app is read-only, in which
// case the pause's own Suspend already did and nothing may write.
func (b *Broker) suspendForExit(reason string) {
	if b.readOnly() {
		log.Info("documents were stored when read-only began; nothing to write now", "reason", reason)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), suspendBudget)
	defer cancel()
	b.Suspend(ctx, reason)
}

// readOnly reports whether the app b serves is read-only. A broker built
// without an app (NewBroker, in tests) serves none and never is.
func (b *Broker) readOnly() bool {
	return b.app != nil && readonly.Active(b.app)
}

// closeAllConns sends every connection a going-away close and does not wait:
// the process goes on draining, and the rooms' teardowns run while the
// database is open. The stop waits for them (see Broker.Stop).
func (b *Broker) closeAllConns() {
	conns := b.liveConns()
	if len(conns) == 0 {
		return
	}
	log.Info("drain: closing realtime connections; clients reconnect to the next server", "count", len(conns))
	for _, lc := range conns {
		go closeGoingAway(lc.conn)
	}
}

// closeGoingAway runs in its own goroutine because Close waits for the
// peer's close frame, and a caller may be the connection's own read loop.
func closeGoingAway(conn *websocket.Conn) {
	_ = conn.Close(websocket.StatusGoingAway, drainCloseReason)
}

// refuseWhileDraining answers an upgrade that reached a draining process.
// Mirrors the read-only refusal shape so the client's backoff treats both
// the same way.
func refuseWhileDraining(re *core.RequestEvent) error {
	re.Response.Header().Set("Retry-After", strconv.Itoa(readonly.RetryAfterSeconds))
	return re.JSON(http.StatusServiceUnavailable, map[string]string{
		"code":    "retry_later",
		"message": "The server is restarting; reconnect.",
	})
}
