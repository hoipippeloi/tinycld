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
//   - drive calls versionhooks.For(item.mime_type) in handleSnapshotVersion /
//     handleRestoreVersion and invokes the matching callback.
//   - drive calls Render / Diff from GET /api/drive/versions/{id}/render
//     and /diff, for the version history preview and compare.
//   - a package calls versionhooks.Register(<mime type>, versionhooks.Hook{...})
//     once per MIME type it edits, in its Register() at process bootstrap.
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

var (
	mu    sync.RWMutex
	hooks = map[string]Hook{}
)

// Register records a hook for the given drive_items.mime_type. Idempotent —
// re-registering replaces. Called from a package's Register() during
// process bootstrap.
func Register(mimeType string, hook Hook) {
	mu.Lock()
	defer mu.Unlock()
	hooks[mimeType] = hook
}

// For returns the registered hook for mimeType, or a zero-value Hook
// (all fields nil) if none. Drive checks the returned fields for nil
// before invoking.
func For(mimeType string) Hook {
	mu.RLock()
	defer mu.RUnlock()
	return hooks[mimeType]
}

// ResetForTest clears the registry. Exposed only for tests — production
// callers never invoke this.
func ResetForTest() {
	mu.Lock()
	defer mu.Unlock()
	hooks = map[string]Hook{}
}
