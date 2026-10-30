// Package groups owns admin-managed user groups and the expansion of group
// grants into per-user membership rows.
//
// A package shares a resource with a group by writing a GRANT row into its own
// membership table: `group` set, `user` empty. This package expands every grant
// into one DERIVED row per member (`group` and `user` both set), keeps those
// rows in sync as membership and grants change, and repairs them at boot. The
// package's existing rules, which test `user`, then keep their logic; each one
// only gains the login guard described below.
//
// Packages declare their membership tables with RegisterGrantTable from their
// Register(app), the same way they declare offboard.RegisterReassignable. Core
// never names a package; tests use a fictional zoo_keepers table.
//
// # Every rule that tests `user` on a grant table must require a login
//
// A grant row stores `user` as "". For a request with no login, PocketBase
// resolves `@request.auth.id` to NULL and rewrites `x = NULL` as
// `(x = "" OR x IS NULL)`. So a rule such as
// `project.zoo_keepers_via_zoo.user ?= @request.auth.id` MATCHES the grant
// row, and a caller with no token gets whatever the grant's role allows: read,
// write and delete. `@request.auth.disabled != true` does not stop it, because
// NULL is not true either.
//
// Therefore every rule, in any collection, that tests the grant table's
// `user` (through a `<table>_via_<field>` back-relation, a relation field, an
// `@collection.<table>` join, or the table's own `user`) must also require
// `@request.auth.id != ""`, conjoined with that test. On a rule that also
// admits anonymous callers another way (a share-link token), put the guard
// inside the member branch only. Call rlstest.RequireAuthGuardOnGrantRules
// from the package's rule tests after its migrations apply; it fails on any
// rule that forgets the guard.
package groups

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

// GrantTable declares a package membership table that carries optional `user`
// and `group` relation fields. ResourceField names the column that points at
// the shared resource (e.g. "project"), which is how a grant's derived rows
// are told apart from another grant's on the same group.
//
// The table's migration MUST add a unique index on (ResourceField, user,
// group) — e.g. `zoo_keepers` uses `zoo, user, group`. Without it, concurrent
// or repeated expansion can insert more than one derived row for the same
// (resource, group, user), since the expander's find-then-write is not itself
// atomic against another writer.
type GrantTable struct {
	Collection    string
	ResourceField string
}

// MembershipEvent describes one user joining or leaving one group. It is
// delivered after the membership row commits.
//
// App is the app that saved the membership. The registry is process global,
// so a listener must do its work through App and not through an app it held
// when it registered: that app can be a different one.
type MembershipEvent struct {
	App     core.App
	UserID  string
	GroupID string
	Joined  bool
}

var (
	mu        sync.RWMutex
	tables    []GrantTable
	listeners []namedListener
)

type namedListener struct {
	name string
	fn   func(MembershipEvent) error
}

// RegisterGrantTable adds a membership table to the registry. Idempotent, and
// a blank collection or resource field is ignored, so a half-filled struct
// cannot register a table the expander then fails on.
func RegisterGrantTable(t GrantTable) {
	if t.Collection == "" || t.ResourceField == "" {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	for _, existing := range tables {
		if existing.Collection == t.Collection {
			return
		}
	}
	tables = append(tables, t)
}

// RegisteredGrantTables returns a snapshot of the registry.
func RegisteredGrantTables() []GrantTable {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]GrantTable, len(tables))
	copy(out, tables)
	return out
}

// OnMembershipChange registers a listener for join/leave events. Every
// listener runs, in registration order. An error is logged and not retried,
// and one listener's error does not stop the others. A package uses this to
// grant or remove per-member resources.
//
// name identifies the listener ("<pkg>.<what>"). A second registration with
// the same name is ignored: every app in a process runs Register, and the
// listener must hear each event once. It does its work through the event's
// App, so one registration serves every app.
func OnMembershipChange(name string, fn func(MembershipEvent) error) {
	mu.Lock()
	defer mu.Unlock()
	for _, existing := range listeners {
		if existing.name == name {
			return
		}
	}
	listeners = append(listeners, namedListener{name: name, fn: fn})
}

// notifyMembership runs every listener. The listeners belong to different
// packages, so one package's failure must not keep the next from hearing the
// event.
func notifyMembership(e MembershipEvent) {
	mu.RLock()
	fns := make([]namedListener, len(listeners))
	copy(fns, listeners)
	mu.RUnlock()
	for _, l := range fns {
		if err := l.fn(e); err != nil {
			log.Error("membership listener failed", "listener", l.name, "user", e.UserID, "group", e.GroupID, "joined", e.Joined, "err", err)
		}
	}
}

// ResetForTesting clears tables and listeners. Tests register their own.
func ResetForTesting() {
	mu.Lock()
	defer mu.Unlock()
	tables = nil
	listeners = nil
}
