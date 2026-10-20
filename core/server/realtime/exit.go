package realtime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"tinycld.org/core/readonly"
)

// ErrStopping is what FlushNow returns once the process has begun to stop:
// the exit's own final flush stores the room, and a save started now could
// still be writing when the database closes.
var ErrStopping = errors.New("realtime: server is stopping")

// exitCloseBound is how long a client has to answer the close frame the exit
// sends before its connection is cut. A browser answers in milliseconds; a
// client that does not answer must not hold up the stop.
const exitCloseBound = time.Second

// exitPhase is where a broker is in its exit.
type exitPhase int32

const (
	// phaseOpen: the broker serves; every save runs on its schedule.
	phaseOpen exitPhase = iota
	// phaseFenced: the stop has begun. Only the exit's own work runs: a
	// room's teardown save, Suspend and its FlushDirty. Timer saves, FlushNow
	// and janitor passes are refused, and no connection is admitted.
	phaseFenced
	// phaseSealed: the final pass has returned. Nothing in the broker touches
	// the database again.
	phaseSealed
)

// exitGate is the broker's single gate on the work that touches the
// database. Every save, checkpoint pass and janitor pass enters it, so the
// stop can refuse new work, wait for the work already running, and know
// when nothing is left.
type exitGate struct {
	phase atomic.Int32

	mu       sync.Mutex
	inFlight int
	// idle is open while work is in flight and closed when the count drops
	// to zero, so a waiter can also watch a deadline.
	idle chan struct{}

	// ctx is the parent of the context every timer, teardown and FlushNow
	// save runs under. Cancelling it ends saves still running when the exit
	// budget runs out.
	ctx    context.Context
	cancel context.CancelFunc
}

func newExitGate() *exitGate {
	ctx, cancel := context.WithCancel(context.Background())
	return &exitGate{ctx: ctx, cancel: cancel}
}

// bound returns a ctx that also ends when the stop cancels the saves still
// running.
func (g *exitGate) bound(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(g.ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// detachedGate serves a SaveCoordinator room that no broker created (unit
// tests call OnRoomCreate with a nil room). It never fences.
var detachedGate = newExitGate()

func (g *exitGate) current() exitPhase {
	return exitPhase(g.phase.Load())
}

// enter claims a slot for one piece of database work. exitWork marks the
// exit's own work, which still runs while fenced. When enter returns true
// the caller must call leave once the work returns; when it returns false
// the work must not run, and the phase says why.
func (g *exitGate) enter(exitWork bool) (exitPhase, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	phase := g.current()
	if phase == phaseSealed || (phase == phaseFenced && !exitWork) {
		return phase, false
	}
	if g.inFlight == 0 {
		g.idle = make(chan struct{})
	}
	g.inFlight++
	return phase, true
}

func (g *exitGate) leave() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.inFlight--
	if g.inFlight == 0 {
		close(g.idle)
		g.idle = nil
	}
}

// advance moves the gate to phase and reports whether it was earlier. Taken
// under mu so no enter sees the old phase after advance returns.
func (g *exitGate) advance(phase exitPhase) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current() >= phase {
		return false
	}
	g.phase.Store(int32(phase))
	return true
}

// waitIdle returns true once no work is in flight, or false when ctx ends
// first. Exit work may still enter while fenced, so it waits for a moment
// with nothing in flight, not for one batch.
func (g *exitGate) waitIdle(ctx context.Context) bool {
	for {
		g.mu.Lock()
		idle := g.idle
		g.mu.Unlock()
		if idle == nil {
			return true
		}
		select {
		case <-idle:
		case <-ctx.Done():
			return false
		}
	}
}

// liveConn is one tracked websocket connection.
type liveConn struct {
	conn *websocket.Conn
	// cut ends the connection's context. A pending Read then closes the
	// socket at once, without the close handshake.
	cut context.CancelFunc
	// left closes once the connection has left its room: its last route
	// call has returned and the room's teardown, when it was the last
	// member, has run.
	left chan struct{}
}

// trackConn records a connection until untrackConn. It refuses once a drain
// or the stop has begun. The check and the insert are one locked step, so a
// stop that begins at the same time either refuses the connection here or
// finds it in its snapshot.
func (b *Broker) trackConn(client *Client, conn *websocket.Conn, cut context.CancelFunc) (*liveConn, bool) {
	b.connsMu.Lock()
	defer b.connsMu.Unlock()
	if draining.Load() || b.gate.current() != phaseOpen {
		return nil, false
	}
	lc := &liveConn{conn: conn, cut: cut, left: make(chan struct{})}
	b.conns[client] = lc
	return lc, true
}

func (b *Broker) untrackConn(client *Client) {
	b.connsMu.Lock()
	defer b.connsMu.Unlock()
	delete(b.conns, client)
}

func (b *Broker) liveConns() []*liveConn {
	b.connsMu.Lock()
	defer b.connsMu.Unlock()
	conns := make([]*liveConn, 0, len(b.conns))
	for _, lc := range b.conns {
		conns = append(conns, lc)
	}
	return conns
}

// stopping reports whether the stop has begun.
func (b *Broker) stopping() bool {
	return b.gate.current() != phaseOpen
}

// adopt records a SaveCoordinator that keeps rooms of this broker, so the
// stop can stop its timers. Called from OnRoomCreate, which runs under b.mu,
// so it takes its own lock.
func (b *Broker) adopt(c *SaveCoordinator) {
	b.coordsMu.Lock()
	defer b.coordsMu.Unlock()
	b.coords[c] = struct{}{}
}

func (b *Broker) adopted() []*SaveCoordinator {
	b.coordsMu.Lock()
	defer b.coordsMu.Unlock()
	coords := make([]*SaveCoordinator, 0, len(b.coords))
	for c := range b.coords {
		coords = append(coords, c)
	}
	return coords
}

// Stop is the broker's exit, run at terminate before the database closes.
// When it returns, no goroutine of the broker touches the database again.
//
// Order:
//  1. Fence: refuse new connections, drop inbound frames, refuse timer
//     saves, FlushNow and janitor passes.
//  2. Stop the janitor and every save timer.
//  3. Send every client a going-away close frame, so it reconnects to the
//     next process, and cut a client that has not closed in exitCloseBound.
//  4. Wait until every connection has left its room (each room's teardown
//     saves it and parks its document) and every save in flight has
//     returned. When ctx ends first, cancel those saves and wait for them to
//     return: a save still running holds the database.
//  5. Final pass: Suspend flushes every dirty room and stores every document,
//     unless the server is read-only, whose own Suspend already did.
//  6. Seal: refuse everything, and wait for any work that entered before.
//
// suspendBudget, or ctx when it ends first, bounds steps 3 to 5 together. ctx
// is the end of the terminate (tinycld.org/core/shutdown's Context): past it
// the process is killed, so a stop still waiting for cancelled work then
// returns and logs the work at Error, and the finalizer closes the database
// under it before the kill can. A second Stop is a no-op.
func (b *Broker) Stop(ctx context.Context, reason string) {
	budget, cancel := context.WithTimeout(ctx, suspendBudget)
	defer cancel()
	if !b.fence(budget, ctx, reason) {
		return
	}
	if readonly.Active() {
		log.Info("documents were stored when read-only began; nothing to write now", "reason", reason)
	} else {
		b.Suspend(budget, reason)
	}
	b.seal(ctx, reason)
	log.Info("realtime stopped", "reason", reason)
}

// Close stops the broker without the final pass: nothing is flushed or
// stored. It is for a broker whose documents need not outlive it, such as a
// test's. A serving process stops through Stop.
func (b *Broker) Close() {
	budget, cancel := context.WithTimeout(context.Background(), suspendBudget)
	defer cancel()
	if b.fence(budget, context.Background(), "close") {
		b.seal(context.Background(), "close")
	}
}

// fence runs steps 1 to 4 of Stop: the waits of steps 3 and 4 end with
// budget, and the wait for the work it then cancels ends with end. It
// reports false when the stop had already begun.
func (b *Broker) fence(budget, end context.Context, reason string) bool {
	if !b.gate.advance(phaseFenced) {
		return false
	}
	close(b.stop)
	for _, c := range b.adopted() {
		c.stopTimers(b)
	}
	conns := b.liveConns()
	closeForExit(budget, conns)
	if b.waitQuiet(budget, conns) {
		return true
	}
	log.Warn("realtime work still running when the stop budget ran out; cancelling it and waiting for it to return",
		"reason", reason, "cause", context.Cause(budget))
	b.gate.cancel()
	if !b.waitQuiet(end, conns) {
		log.Error("closing the app under realtime work that did not return by the terminate's deadline",
			"reason", reason)
	}
	return true
}

// seal refuses all further work and waits, until end, for the work that
// entered before.
func (b *Broker) seal(end context.Context, reason string) {
	b.gate.advance(phaseSealed)
	if !b.gate.waitIdle(end) {
		log.Error("closing the app under realtime work that did not return by the terminate's deadline",
			"reason", reason)
	}
	b.gate.cancel()
}

// waitQuiet waits until every connection in conns has left its room and the
// gate has nothing in flight, or ctx ends.
func (b *Broker) waitQuiet(ctx context.Context, conns []*liveConn) bool {
	for _, lc := range conns {
		select {
		case <-lc.left:
		case <-ctx.Done():
			return false
		}
	}
	return b.gate.waitIdle(ctx)
}

// closeForExit sends every connection a going-away close frame and cuts the
// ones that have not left their room after exitCloseBound, or when ctx ends
// first.
func closeForExit(ctx context.Context, conns []*liveConn) {
	if len(conns) == 0 {
		return
	}
	log.Info("stop: closing realtime connections; clients reconnect to the next server", "count", len(conns))
	for _, lc := range conns {
		go closeGoingAway(lc.conn)
	}
	cutCtx, cancel := context.WithTimeout(ctx, exitCloseBound)
	defer cancel()
	for i, lc := range conns {
		select {
		case <-lc.left:
			continue
		case <-cutCtx.Done():
		}
		cut := 0
		for _, rest := range conns[i:] {
			select {
			case <-rest.left:
			default:
				rest.cut()
				cut++
			}
		}
		log.Info("stop: cut realtime connections that did not answer the close", "count", cut, "bound", exitCloseBound)
		return
	}
}
