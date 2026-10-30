// Package versionhooks owns the per-MIME-type extension point drive uses
// to surface package-specific behavior around version snapshot/restore.
//
// Why this lives in core (and not drive): drive can't host this registry
// without forcing any package that wants to participate (text, calc, …)
// to require drive as a Go module dependency. The lean-shell guarantee
// — that a workspace assembled with only text but no drive must still
// build — forbids text→drive imports. Core already sits at the bottom
// of every package's dependency graph, so the hook registry lives here.
//
// Wiring:
//   - drive calls versionhooks.For(app, item.mime_type) in handleSnapshotVersion /
//     handleRestoreVersion and invokes the matching callback.
//   - drive calls Render / Diff from GET /api/drive/versions/{id}/render
//     and /diff, for the version history preview and compare.
//   - a package calls versionhooks.Register(app, <mime type>, versionhooks.Hook{...})
//     once per MIME type it edits, in its Register(app).
//     The key is drive_items.mime_type: drive_items has no other field
//     that names the editing package.
//
// Hooks are best-effort. Drive logs failures but does not roll back the
// version row — the docx blob round-trip still works either way; the
// hook contributes package-specific metadata on top.
package versionhooks

import (
	"context"
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// Hook bundles a snapshot + restore callback for a given drive_items.type.
type Hook struct {
	// OnSnapshot fires after the drive_item_versions row has been
	// created and the file blob copied. The package can read the live
	// state (e.g. an in-memory Y.Doc) and write metadata back to the
	// version row.
	OnSnapshot func(app core.App, item *core.Record, version *core.Record) error

	// OnRestore fires after the drive_item file has been replaced from
	// the version's blob. The package can read the version's
	// package-specific fields (e.g. yjs_state) and apply them to the
	// live state.
	OnRestore func(app core.App, item *core.Record, version *core.Record) error

	// Render and Diff are optional. Drive's history screen offers preview
	// and compare only for a type that sets them.
	Render RenderFn
	Diff   DiffFn
}

// RenderFn returns read-only HTML for one version of item. authUserID is
// the caller; a renderer that inlines other files must check access as
// that user.
type RenderFn func(ctx context.Context, app core.App, item, version *core.Record, authUserID string) (string, error)

// DiffFn returns HTML for `to` with <ins>/<del> marks against `from`.
// from is nil when `to` is the first version: everything is inserted.
type DiffFn func(ctx context.Context, app core.App, item, from, to *core.Record, authUserID string) (string, error)

// registry is one app's hooks. Each app keeps its own: a hook closes over the
// registering package's runtime for that app (text's live documents), so one
// app's snapshot must never reach another app's runtime.
type registry struct {
	mu    sync.RWMutex
	hooks map[string]Hook
}

var registryKey = appstate.NewKey[*registry]("versionhooks.hooks")

func registryFor(app core.App) *registry {
	return registryKey.GetOrInit(app, func() *registry {
		return &registry{hooks: map[string]Hook{}}
	})
}

// Register records app's hook for the given drive_items.mime_type. Idempotent —
// re-registering replaces. Called from a package's Register(app).
func Register(app core.App, mimeType string, hook Hook) {
	r := registryFor(app)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hooks[mimeType] = hook
}

// For returns app's hook for mimeType, or a zero-value Hook (all fields nil)
// if none. Drive checks the returned fields for nil before invoking.
func For(app core.App, mimeType string) Hook {
	r := registryFor(app)
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.hooks[mimeType]
}
