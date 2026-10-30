// Package drainhooks lets a package act the moment a supervised server
// begins to drain. A supervisor drains the old server only once the next
// one is ready on the same ports, so from that moment new connections
// belong to the next server. Core drains its HTTP server itself, and
// registers here to end its realtime streams; a package that serves its own
// protocol on a port the supervisor passed in registers here to stop
// accepting on that port at once, instead of when PocketBase's terminate
// hooks reach it after the HTTP drain.
//
// Core names no package: each package calls OnBegin from its own Register().
// Handlers belong to the app that registered them. A drain of one app runs
// that app's handlers; a drain of the whole process runs every app's.
package drainhooks

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("drainhooks")

type handler struct {
	name string
	fn   func()
}

// handlers is one app's registry.
type handlers struct {
	mu      sync.Mutex
	list    []handler
	tracked bool
}

var handlersKey = appstate.NewKey[*handlers]("drainhooks.handlers")

// apps lists, in registration order, every app that registered a handler
// and has not terminated, so a drain of the whole process reaches each.
var (
	appsMu sync.Mutex
	apps   []core.App
)

// OnBegin registers fn to run when app begins to drain. fn must return
// quickly: the drain waits for it before it lets in-flight requests finish.
// A second registration under the same name on the same app replaces the
// first, so a Register() that runs again does not run its handler twice.
// Another app's registration under the same name is its own.
func OnBegin(app core.App, name string, fn func()) {
	hs := handlersKey.GetOrInit(app, func() *handlers { return &handlers{} })
	hs.mu.Lock()
	first := !hs.tracked
	hs.tracked = true
	replaced := false
	for i, h := range hs.list {
		if h.name == name {
			hs.list[i].fn = fn
			replaced = true
			break
		}
	}
	if !replaced {
		hs.list = append(hs.list, handler{name: name, fn: fn})
	}
	hs.mu.Unlock()
	if first {
		track(app)
	}
}

// track adds app to the process drain and takes it out when app terminates.
func track(app core.App) {
	appsMu.Lock()
	apps = append(apps, app)
	appsMu.Unlock()
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		untrack(app)
		return e.Next()
	})
}

func untrack(app core.App) {
	appsMu.Lock()
	defer appsMu.Unlock()
	for i, a := range apps {
		if a == app {
			apps = append(apps[:i], apps[i+1:]...)
			return
		}
	}
}

// RunBegin runs every handler app registered, in registration order. A
// handler that panics is logged and the rest still run: one package's
// failure must not leave another package's port accepting.
func RunBegin(app core.App) {
	hs, ok := handlersKey.GetOk(app)
	if !ok {
		return
	}
	hs.mu.Lock()
	list := append([]handler(nil), hs.list...)
	hs.mu.Unlock()
	for _, h := range list {
		run(h)
	}
}

// RunBeginAll runs RunBegin for every app in the process, in the order the
// apps first registered.
func RunBeginAll() {
	appsMu.Lock()
	all := append([]core.App(nil), apps...)
	appsMu.Unlock()
	for _, app := range all {
		RunBegin(app)
	}
}

func run(h handler) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("a drain-begin handler panicked", "handler", h.name, "panic", r)
		}
	}()
	h.fn()
}

// ResetForTest empties the process drain list. An app's own handlers live on
// the app and go with it.
func ResetForTest() {
	appsMu.Lock()
	defer appsMu.Unlock()
	apps = nil
}
