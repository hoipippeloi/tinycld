package coreserver

import (
	"sync"

	"github.com/grafana/sobek"
	"github.com/pocketbase/pocketbase"
)

// The core→TS binding seam.
//
// The PocketBase fork calls jsvm.Config.OnInit on every JS VM (both
// the hook loader and the executor/callback pools). We use it to install a
// small, stable set of native `$`-bindings that package `.pb.ts` hooks can call
// — the ONE auditable surface untrusted package TS is allowed to reach.
// Keeping this surface minimal is a deliberate security goal: powerful Go
// capabilities (raw SQL, protocol codecs, filesystem) stay host-side and are
// exposed only through these enumerable bindings, never as an open-ended $app
// surface.
//
// Data-plane work that fires on record events (FTS sync, thumbnails, audit) is
// deliberately NOT a binding — core registers those as its own config-driven Go
// record hooks so they never cross the VM boundary and package TS can't skip
// them.
// Bindings are reserved for logic that must ORIGINATE in package TS.

// JSVMBinder installs one binding namespace onto a freshly-initialized VM.
// A core sub-package (fts, carddav, …) registers a binder via RegisterJSVMBinder
// so it can expose native funcs to package TS without coreserver importing it
// (mirrors the SetShareSessionResolver decoupling pattern). The binder should
// build its namespace object with NewBindNamespace and vm.Set it under a single
// `$name` global. It is called once per VM; keep it cheap and side-effect free
// beyond the vm.Set.
type JSVMBinder func(vm *sobek.Runtime, app *pocketbase.PocketBase) error

type namedBinder struct {
	name string
	fn   JSVMBinder
}

// binders is process-wide: a binder takes the app as an argument, so one
// registry serves every app in the process.
var (
	bindersMu sync.RWMutex
	binders   []namedBinder
)

// RegisterJSVMBinder adds a binder invoked on every VM via OnInit, under a
// name unique to the registering package. Call it from a sub-package's
// Register(app). Every app in a process runs the same Register, so a second
// registration under the same name replaces the first in place rather than
// installing the namespace twice on every VM.
//
// This must happen BEFORE jsvm.Register runs, because that executes the hook
// files synchronously — coreserver.Register calls RegisterExtras first for
// exactly this reason. Safe for concurrent registration.
func RegisterJSVMBinder(name string, b JSVMBinder) {
	bindersMu.Lock()
	defer bindersMu.Unlock()
	for i := range binders {
		if binders[i].name == name {
			binders[i].fn = b
			return
		}
	}
	binders = append(binders, namedBinder{name: name, fn: b})
}

// BuildJsvmOnInit returns the jsvm.Config.OnInit callback. It runs every
// registered binder against the VM. A binder error is fatal for that VM — we
// panic, matching jsvm's own MustRegister failure mode, because a VM missing a
// core binding would surface as opaque "undefined is not a function" errors in
// hook code rather than a clear boot failure.
func BuildJsvmOnInit(app *pocketbase.PocketBase) func(vm *sobek.Runtime) {
	return func(vm *sobek.Runtime) {
		bindersMu.RLock()
		defer bindersMu.RUnlock()
		for _, b := range binders {
			if err := b.fn(vm, app); err != nil {
				panic("coreserver: JS binding install failed: " + err.Error())
			}
		}
	}
}

// NewBindNamespace builds a plain JS object whose keys are the given native Go
// funcs, ready to vm.Set under a `$name` global. Values are typically
// func(...) results; sobek marshals Go funcs into callable JS functions.
//
//	obj, _ := NewBindNamespace(vm, map[string]any{
//	    "search": func(q string) ([]any, error) { ... },
//	})
//	vm.Set("$fts", obj)
func NewBindNamespace(vm *sobek.Runtime, members map[string]any) (*sobek.Object, error) {
	obj := vm.NewObject()
	for name, fn := range members {
		if err := obj.Set(name, fn); err != nil {
			return nil, err
		}
	}
	return obj, nil
}
