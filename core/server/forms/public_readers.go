package forms

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

// signedInReadRule is the forms list and view rule with no package clause:
// any signed-in, enabled user reads the definitions. The migration that
// creates the collection (2090000000_create_forms.js) writes the same text,
// so a boot with no registered clause saves nothing; a test holds the two
// equal.
const signedInReadRule = `@request.auth.id != "" && @request.auth.disabled != true`

var publicReaders = struct {
	sync.Mutex
	clauses  []string
	composed bool
}{}

// RegisterPublicReader adds a rule clause under which an anonymous caller may
// list and view forms. A package whose screens render a form without a
// session (a share-link visitor) registers the clause that vouches for that
// visitor, written from the forms record's point of view, e.g. a back-relation
// to the package's rows and its share token header. Core never names the
// package; the clause is the package's.
//
// Call it from the package's Register, before the app serves. Registering a
// new clause after the rules were composed is a programming error and panics:
// the served rule would silently lack it. Registering a clause already
// composed is a no-op, so a process that runs Register for a second app does
// not fail.
func RegisterPublicReader(clause string) {
	publicReaders.Lock()
	defer publicReaders.Unlock()
	if slices.Contains(publicReaders.clauses, clause) {
		return
	}
	if publicReaders.composed {
		panic(fmt.Sprintf("forms: RegisterPublicReader(%q) after the forms read rules were composed; register from the package's Register, before serve", clause))
	}
	publicReaders.clauses = append(publicReaders.clauses, clause)
}

// composedReadRule is the signed-in rule with each registered clause as one
// more disjunct, in sorted order so the text does not depend on the order
// packages registered in (a reorder would otherwise rewrite the rule on boot).
// It closes registration: a clause registered later would never be applied.
// The second result reports whether any clause was registered.
func composedReadRule() (string, bool) {
	publicReaders.Lock()
	defer publicReaders.Unlock()
	publicReaders.composed = true
	clauses := slices.Clone(publicReaders.clauses)
	slices.Sort(clauses)
	rule := signedInReadRule
	for _, c := range clauses {
		rule += " || (" + c + ")"
	}
	return rule, len(clauses) > 0
}

// ApplyPublicReaders writes the composed rule to the forms list and view
// rules, saving only when the text changed, so an unchanged boot writes
// nothing. Register runs it on serve; a package test runs it to give a test
// app the rules a served install has.
//
// An app without the forms collection (a bare test app that skipped core's
// migrations) has nothing to compose onto; that is an error only when a
// package registered a clause it expects to be served.
func ApplyPublicReaders(app core.App) error {
	rule, vouched := composedReadRule()
	col, err := app.FindCollectionByNameOrId(formsCollection)
	if errors.Is(err, sql.ErrNoRows) && !vouched {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find %s: %w", formsCollection, err)
	}
	if col.ListRule != nil && *col.ListRule == rule && col.ViewRule != nil && *col.ViewRule == rule {
		return nil
	}
	col.ListRule = &rule
	col.ViewRule = &rule
	return app.Save(col)
}
