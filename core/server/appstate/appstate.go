// Package appstate keeps state that belongs to one app on that app.
//
// A process can run several apps. A package-level variable is shared by all
// of them, so a value that belongs to one app (a limit, a credential source,
// a mode flag) must not live in one. Key stores it in the app's own store.
package appstate

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"

	"github.com/pocketbase/pocketbase/core"
)

const prefix = "appstate:"

// Key is a typed slot in an app's store. Build it with NewKey, normally once
// as a package-level variable: the key is code-level data, the value is not.
type Key[T any] struct{ name string }

// NewKey returns a key stored under "appstate:" + name. Use "<pkg>.<field>"
// so names stay unique across the process.
func NewKey[T any](name string) Key[T] {
	return Key[T]{name: prefix + name}
}

// Get returns the app's value, or the zero value when it is unset.
func (k Key[T]) Get(app core.App) T {
	v, _ := k.GetOk(app)
	return v
}

// GetOk returns the app's value and whether it is set. A stored value of
// another type reads as unset rather than panicking.
func (k Key[T]) GetOk(app core.App) (T, bool) {
	raw, ok := app.Store().GetOk(k.name)
	if !ok {
		var zero T
		return zero, false
	}
	v, ok := raw.(T)
	return v, ok
}

// Set stores v for the app, replacing any earlier value.
func (k Key[T]) Set(app core.App, v T) {
	app.Store().Set(k.name, v)
}

// GetOrInit returns the app's value, storing init() first when it is unset.
// The store holds its write lock across init, so two goroutines racing on the
// same app get one value. init must not touch the app's store: it would
// deadlock on that lock.
func (k Key[T]) GetOrInit(app core.App, init func() T) T {
	raw := app.Store().GetOrSet(k.name, func() any { return init() })
	v, _ := raw.(T)
	return v
}

// Delete removes the app's value.
func (k Key[T]) Delete(app core.App) {
	app.Store().Remove(k.name)
}

var idKey = NewKey[string]("appstate.id")

// ID returns a stable id for the app, unique in the process. Use it to prefix
// keys of limiters and maps that live outside the app's store, so two apps
// never share a budget or an entry.
func ID(app core.App) string {
	return idKey.GetOrInit(app, func() string {
		dir := app.DataDir()
		if abs, err := filepath.Abs(dir); err == nil {
			dir = abs
		}
		sum := sha256.Sum256([]byte(dir))
		return hex.EncodeToString(sum[:])[:16]
	})
}
