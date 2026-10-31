package coreserver

import (
	"sync"
	"sync/atomic"

	"github.com/grafana/sobek"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"

	"tinycld.org/core/appstate"
)

// The Go→TS hook-point seam.
//
// This is the counterpart to the `$`-bindings in jsvm_binds.go, running the
// other direction: those let package TS call into Go, this lets Go call into
// package TS at a point the host owns (a request path, a protocol handler).
// It exists for behavior a declarative config can't express — "block this
// filename", "hide these entries" — without moving the whole data model into
// configuration.
//
// The design constraint that shapes everything here: **the fast path must not
// touch a JS VM.** A hook point that nobody registered costs one atomic load.
// That matters because jsvm's pool falls back to constructing an entire new
// sobek.Runtime — the full bind chain, tens of milliseconds — once every pooled
// executor is busy (plugins/jsvm/pool.go). A protocol server that fanned out to
// the VM on every operation would hit that cliff under exactly the concurrent
// load it is meant to serve. So: orgs that customize pay for it; orgs that
// don't pay nothing.
//
// Security note: a hook point is an opportunity for package TS to RESTRICT or
// RESHAPE a decision, never to widen one. Callers must apply their own
// authoritative check first and treat a hook's answer as an additional
// constraint — see the AND-only rule on the WebDAV permission points.

// HookResult is what a TS handler returned, plus whether a handler actually
// ran. Handled is false when no handler is registered, which lets a caller
// distinguish "TS said nothing" from "TS returned a zero value".
type HookResult struct {
	Value   any
	Handled bool
}

// HookPoint is one named place where Go will call registered package TS.
//
// The zero value is not usable — build one with RegisterHookPoint.
type HookPoint struct {
	name string

	// enabled mirrors len(handlers) > 0 so Enabled() is a single atomic load
	// on the hot path, with no mutex and no allocation.
	enabled atomic.Bool

	mu       sync.RWMutex
	handlers []jsvm.Callable
}

// hookRegistry is one app's hook points and loader binders. A TS handler is
// compiled on the loader VM of the app whose hook files registered it, and it
// runs on that app's executor pool with that app's $app. Only that app may
// reach it: a process-wide registry would run one app's handler for every app
// in the process.
type hookRegistry struct {
	mu      sync.RWMutex
	points  map[string]*HookPoint
	binders []LoaderBinder
}

var hookRegistryKey = appstate.NewKey[*hookRegistry]("coreserver.hooks")

func hooksOf(app core.App) *hookRegistry {
	return hookRegistryKey.GetOrInit(app, func() *hookRegistry {
		return &hookRegistry{points: map[string]*HookPoint{}}
	})
}

// RegisterHookPoint declares a hook point by name on app and returns it.
// Calling it twice with the same app and name returns the same HookPoint, so a
// package and its host can both reach a point without ordering constraints.
// Another app gets its own point under the same name.
//
// Declare points at Register time; the returned pointer is stable.
func RegisterHookPoint(app core.App, name string) *HookPoint {
	r := hooksOf(app)
	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, ok := r.points[name]; ok {
		return existing
	}
	hp := &HookPoint{name: name}
	r.points[name] = hp
	return hp
}

// LookupHookPoint returns a hook point previously registered on app, or nil.
func LookupHookPoint(app core.App, name string) *HookPoint {
	r := hooksOf(app)
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.points[name]
}

// Name returns the hook point's registered name.
func (h *HookPoint) Name() string { return h.name }

// Enabled reports whether any TS handler is registered. This is THE fast-path
// check: one atomic load, no lock, no VM. Always gate on it before building a
// payload — constructing the argument map for a hook nobody registered is
// wasted work on a hot path.
//
//	if hp.Enabled() {
//	    res, err := hp.Call(map[string]any{...})
//	    ...
//	}
func (h *HookPoint) Enabled() bool { return h.enabled.Load() }

// Add registers a handler. Handlers run in registration order; the last
// non-nil result wins. Safe for concurrent use, though in practice
// registration happens once at hook-load time.
func (h *HookPoint) Add(fn jsvm.Callable) {
	if fn == nil {
		return
	}
	h.mu.Lock()
	h.handlers = append(h.handlers, fn)
	h.mu.Unlock()
	h.enabled.Store(true)
}

// Call invokes every registered handler with the given payload and returns the
// last non-nil result. A handler error aborts the chain and is returned — for a
// veto point (beforeWrite, beforeDelete) that is exactly the rejection path:
// the TS throws, Go refuses the operation.
//
// Returns Handled=false when nothing is registered, so a caller can tell an
// absent hook from one that returned nil/false.
func (h *HookPoint) Call(payload map[string]any) (HookResult, error) {
	if !h.enabled.Load() {
		return HookResult{}, nil
	}

	h.mu.RLock()
	handlers := make([]jsvm.Callable, len(h.handlers))
	copy(handlers, h.handlers)
	h.mu.RUnlock()

	out := HookResult{}
	for _, fn := range handlers {
		v, err := fn(payload)
		if err != nil {
			return HookResult{}, err
		}
		out.Handled = true
		if v != nil {
			out.Value = v
		}
	}
	return out, nil
}

// LoaderBinder installs loader-only bindings — the ones that REGISTER a TS
// handler against a hook point. Unlike JSVMBinder (which runs per VM), this
// runs once, on the hooks loader runtime, and receives a compiler that turns a
// JS handler into a Go-callable closure.
type LoaderBinder func(loader *sobek.Runtime, compile jsvm.Compiler, app *pocketbase.PocketBase) error

// RegisterLoaderBinder adds a binder invoked once on app's hooks loader VM.
// Call it from a sub-package's Register(app). Like RegisterJSVMBinder, this
// must happen BEFORE jsvm.Register — the hook files execute synchronously
// inside it, so a binding registered later would not exist when a .pb.ts calls
// it.
func RegisterLoaderBinder(app core.App, b LoaderBinder) {
	r := hooksOf(app)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.binders = append(r.binders, b)
}

// JSVMBindings returns the two jsvm callbacks that install core's JS seams:
// the per-VM `$`-namespaces (TS→Go) and the loader-only registration bindings
// (Go→TS). coreserver.Register wires these itself; this exists for a host that
// registers jsvm on its own — notably a composing server's serve-org command,
// which builds its app rather than going through Register.
//
// A host that omits these gets VMs with no `$` bindings and no way for package
// TS to register a hook handler.
func JSVMBindings(app *pocketbase.PocketBase) (func(*sobek.Runtime), jsvm.LoaderInit) {
	return BuildJsvmOnInit(app), BuildJsvmOnLoaderInit(app)
}

// BuildJsvmOnLoaderInit returns the jsvm.Config.OnLoaderInit callback. It runs
// the binders registered on app. Mirrors BuildJsvmOnInit's failure mode: a
// binder error panics, because a loader missing its registration binding would
// surface later as an opaque "undefined is not a function" inside hook code
// rather than a clear boot failure.
func BuildJsvmOnLoaderInit(app *pocketbase.PocketBase) jsvm.LoaderInit {
	return func(loader *sobek.Runtime, compile jsvm.Compiler) {
		r := hooksOf(app)
		// A copy, so a binder may register a hook point (which takes r.mu)
		// without deadlocking against this loop.
		r.mu.RLock()
		binders := append([]LoaderBinder(nil), r.binders...)
		r.mu.RUnlock()
		for _, b := range binders {
			if err := b(loader, compile, app); err != nil {
				panic("coreserver: JS loader binding install failed: " + err.Error())
			}
		}
	}
}
