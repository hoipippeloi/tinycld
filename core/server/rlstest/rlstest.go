// Package rlstest runs a package's SHIPPED JavaScript migrations against a
// PocketBase test app, so a rule-level test asserts the rules the product
// actually ships rather than a copy of them.
//
// It exists because of a specific failure. Seven RLS suites across this tree
// re-declared the rule strings they were testing as constants in the test
// file, with a comment promising the constant was "copied verbatim from the
// migration". Every one of them matched byte-for-byte, so they looked like
// tripwires — and then drive's `createRule` lost its guest-exclusion clause in
// a later migration and the suite that existed to catch exactly that stayed
// green, because it was asserting against its own copy of the old rule.
//
// A test that restates the thing it is testing cannot fail for the reason you
// wrote it. Load the rule from the migration instead.
package rlstest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/tests"
)

// Apply runs every .js migration in the given directories against app, each
// directory in filename order, exactly as a real boot would.
//
// Pass more than one directory when the package under test has migrations that
// build on another package's schema — text's version migrations alter drive's
// `drive_item_versions`, for instance. Order matters: the dependency's
// directory comes first.
//
// Collections that no listed migration creates must exist on the app already.
// A bare collection carrying the fields the rules reference is enough.
func Apply(t testing.TB, app core.App, migrationsDirs ...string) {
	t.Helper()

	if len(migrationsDirs) == 0 {
		t.Fatal("rlstest: Apply needs at least one migrations directory")
	}

	// jsvm registers the migrations into app's own list, so nothing carries
	// over to another test's app.
	if err := applyDirs(app, t.TempDir(), migrationsDirs); err != nil {
		t.Fatalf("rlstest: %v", err)
	}
}

// applyDirs runs the .js migrations of each directory against app, one
// directory at a time.
//
// hooksDir must be empty: jsvm requires one, but rules come from migrations,
// so no hook file may run and the result is the migrations alone.
func applyDirs(app core.App, hooksDir string, migrationsDirs []string) error {
	for _, dir := range migrationsDirs {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", dir, err)
		}
		if _, err := migrationFiles(abs); err != nil {
			return fmt.Errorf("read %s: %w", abs, err)
		}

		// One directory at a time: each package's migrations are ordered among
		// themselves by filename, but two packages' timestamps interleaved
		// would run them in an order no real boot produces. Running after each
		// directory's registration applies only that directory's files.
		if err := jsvm.Register(app, jsvm.Config{MigrationsDir: abs, HooksDir: hooksDir}); err != nil {
			return fmt.Errorf("register jsvm for %s: %w", abs, err)
		}
		if err := app.RunAppMigrations(); err != nil {
			return fmt.Errorf("apply migrations from %s: %w", abs, err)
		}
	}
	return nil
}

// ApplyWithHooks is Apply plus the package's real pb-hooks directory, so a
// test can exercise what an org's OWN PROCESS on a managed deployment runs:
// PocketBase, the shipped migrations, and the package's JS hooks — but none of
// its Go.
//
// That combination is the one no existing suite covered. Tests that bind the
// Go hooks prove the standalone app is safe and say nothing about such a
// process; tests that bind nothing miss behaviour it genuinely has.
func ApplyWithHooks(t testing.TB, app core.App, hooksDir string, migrationsDirs ...string) {
	t.Helper()

	abs, err := filepath.Abs(hooksDir)
	if err != nil {
		t.Fatalf("rlstest: resolve %s: %v", hooksDir, err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("rlstest: hooks dir %s: %v", abs, err)
	}

	if err := applyDirs(app, t.TempDir(), migrationsDirs); err != nil {
		t.Fatalf("rlstest: %v", err)
	}

	// The hooks pass registers the real hook files. It comes last so the
	// collections they reference already exist.
	if err := jsvm.Register(app, jsvm.Config{
		MigrationsDir: t.TempDir(),
		HooksDir:      abs,
		HooksPoolSize: 1,
	}); err != nil {
		t.Fatalf("rlstest: register hooks from %s: %v", abs, err)
	}
}

// Rule returns one of a collection's five access rules after the migrations
// have been applied, so a test can assert behaviour against the shipped rule
// and report the rule text when it fails.
//
// A nil rule (superusers only) is returned as ("", false) — distinct from a
// rule that is the empty string, which PocketBase reads as "public".
func Rule(t testing.TB, app core.App, collection, kind string) (string, bool) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatalf("rlstest: find %s: %v", collection, err)
	}
	var r *string
	switch kind {
	case "list":
		r = col.ListRule
	case "view":
		r = col.ViewRule
	case "create":
		r = col.CreateRule
	case "update":
		r = col.UpdateRule
	case "delete":
		r = col.DeleteRule
	default:
		t.Fatalf("rlstest: unknown rule kind %q", kind)
	}
	if r == nil {
		return "", false
	}
	return *r, true
}

// RequireRuleContains asserts a shipped rule carries a given clause.
//
// This is the guard against silent clause loss: a later migration that
// restates a rule and drops one predicate — which is how drive's guest
// exclusion disappeared — fails here naming the clause and printing the rule
// as it now ships.
//
// It is a complement to behavioural deny-tests, not a substitute. Assert the
// behaviour; use this to say which clause is meant to produce it.
func RequireRuleContains(t testing.TB, app core.App, collection, kind, clause string) {
	t.Helper()
	rule, ok := Rule(t, app, collection, kind)
	if !ok {
		t.Fatalf("%s.%sRule is nil (superusers only); expected it to contain %q",
			collection, kind, clause)
	}
	if !strings.Contains(rule, clause) {
		t.Fatalf("%s.%sRule lost the clause %q\n  shipped rule: %s",
			collection, kind, clause, rule)
	}
}

// NewApp builds a TestApp for rule testing. Callers create the collections
// their migrations expect, then call Apply.
func NewApp(t testing.TB) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("rlstest: NewTestApp: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })
	return app
}

// MigrationsDir resolves a sibling package's pb-migrations directory from a
// test running inside that package's server/ directory.
func MigrationsDir(t testing.TB, relative string) string {
	t.Helper()
	abs, err := filepath.Abs(relative)
	if err != nil {
		t.Fatalf("rlstest: resolve %s: %v", relative, err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("rlstest: %s: %v", abs, err)
	}
	return abs
}
