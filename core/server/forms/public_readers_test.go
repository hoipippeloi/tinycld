package forms

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/rlstest"
)

// resetPublicReaders clears registration between tests; the state is
// package-global because packages register before any app exists.
func resetPublicReaders(t *testing.T) {
	t.Helper()
	reset := func() {
		publicReaders.Lock()
		defer publicReaders.Unlock()
		publicReaders.clauses = nil
		publicReaders.composed = false
	}
	reset()
	t.Cleanup(reset)
}

func ruleOnly(rule string, _ bool) string { return rule }

const gizmoReader = `@request.headers.x_share_token = "gizmo-token"`

// readersApp is the assembled core app with one form, its read rules composed
// from whatever the test registered, as a served install would have them.
func readersApp(t *testing.T) (*tests.TestApp, *core.Record) {
	t.Helper()
	app := rlstest.NewAssembledApp(t)
	col, err := app.FindCollectionByNameOrId(formsCollection)
	if err != nil {
		t.Fatal(err)
	}
	form := core.NewRecord(col)
	form.Set("host", "gizmos:widget")
	form.Set("name", "bug")
	form.Set("slug", "bug")
	form.Set("definition", []byte(minimalDefinition))
	form.Set("order", 1)
	if err := app.Save(form); err != nil {
		t.Fatal(err)
	}
	if err := ApplyPublicReaders(app); err != nil {
		t.Fatal(err)
	}
	return app, form
}

type readCase struct {
	name    string
	url     string
	headers map[string]string
	status  int
	content []string
	absent  []string
}

func runReads(t *testing.T, app *tests.TestApp, cases []readCase) {
	t.Helper()
	for _, c := range cases {
		sc := tests.ApiScenario{
			Name:                  c.name,
			Method:                http.MethodGet,
			URL:                   c.url,
			Headers:               c.headers,
			ExpectedStatus:        c.status,
			ExpectedContent:       c.content,
			NotExpectedContent:    c.absent,
			TestAppFactory:        func(testing.TB) *tests.TestApp { return app },
			DisableTestAppCleanup: true,
		}
		sc.Test(t)
	}
}

func TestPublicReaders_MigratedRuleIsTheSignedInConst(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	for _, kind := range []string{"list", "view"} {
		rule, ok := rlstest.Rule(t, app, formsCollection, kind)
		if !ok || rule != signedInReadRule {
			t.Errorf("forms %s rule = %q, want signedInReadRule %q: the migration and the Go const drifted", kind, rule, signedInReadRule)
		}
	}
}

func TestPublicReaders_NoClauseNeedsASession(t *testing.T) {
	resetPublicReaders(t)
	app, form := readersApp(t)
	_, memberToken := formsUser(t, app, "member@test.local", "member")
	runReads(t, app, []readCase{
		{name: "anonymous list sees no form", url: "/api/collections/forms/records", status: 200, content: []string{`"totalItems":0`}, absent: []string{form.Id}},
		{name: "anonymous view", url: "/api/collections/forms/records/" + form.Id, status: 404, content: []string{`"data":{}`}},
		{name: "member lists", url: "/api/collections/forms/records", headers: map[string]string{"Authorization": memberToken}, status: 200, content: []string{form.Id}},
	})
}

func TestPublicReaders_RegisteredClauseAdmitsItsVisitor(t *testing.T) {
	resetPublicReaders(t)
	RegisterPublicReader(gizmoReader)
	app, form := readersApp(t)
	_, memberToken := formsUser(t, app, "member@test.local", "member")
	right := map[string]string{"x_share_token": "gizmo-token"}
	wrong := map[string]string{"x_share_token": "not-the-token"}
	runReads(t, app, []readCase{
		{name: "token lists", url: "/api/collections/forms/records", headers: right, status: 200, content: []string{form.Id}},
		{name: "token views", url: "/api/collections/forms/records/" + form.Id, headers: right, status: 200, content: []string{`"slug":"bug"`}},
		{name: "wrong token lists nothing", url: "/api/collections/forms/records", headers: wrong, status: 200, content: []string{`"totalItems":0`}, absent: []string{form.Id}},
		{name: "wrong token cannot view", url: "/api/collections/forms/records/" + form.Id, headers: wrong, status: 404, content: []string{`"data":{}`}},
		{name: "member lists", url: "/api/collections/forms/records", headers: map[string]string{"Authorization": memberToken}, status: 200, content: []string{form.Id}},
	})
	want := signedInReadRule + " || (" + gizmoReader + ")"
	if rule, _ := rlstest.Rule(t, app, formsCollection, "list"); rule != want {
		t.Fatalf("composed list rule = %q, want %q", rule, want)
	}
}

func TestPublicReaders_ClausesComposeSortedAndOnce(t *testing.T) {
	resetPublicReaders(t)
	RegisterPublicReader(`b = 1`)
	RegisterPublicReader(`a = 1`)
	RegisterPublicReader(`b = 1`)
	if got, want := ruleOnly(composedReadRule()), signedInReadRule+" || (a = 1) || (b = 1)"; got != want {
		t.Fatalf("composed = %q, want %q", got, want)
	}
}

func TestPublicReaders_UnchangedBootSavesNothing(t *testing.T) {
	resetPublicReaders(t)
	RegisterPublicReader(gizmoReader)
	app, _ := readersApp(t)
	saves := 0
	app.OnCollectionUpdate(formsCollection).BindFunc(func(e *core.CollectionEvent) error {
		saves++
		return e.Next()
	})
	if err := ApplyPublicReaders(app); err != nil {
		t.Fatal(err)
	}
	if saves != 0 {
		t.Fatalf("a second boot with the same clauses saved the forms collection %d times", saves)
	}
}

func TestPublicReaders_NoClauseBootSavesNothing(t *testing.T) {
	resetPublicReaders(t)
	app := rlstest.NewAssembledApp(t)
	saves := 0
	app.OnCollectionUpdate(formsCollection).BindFunc(func(e *core.CollectionEvent) error {
		saves++
		return e.Next()
	})
	if err := ApplyPublicReaders(app); err != nil {
		t.Fatal(err)
	}
	if saves != 0 {
		t.Fatalf("a boot with no clause rewrote the migrated rule (%d saves)", saves)
	}
}

func TestPublicReaders_RegisteringANewClauseAfterServePanics(t *testing.T) {
	resetPublicReaders(t)
	RegisterPublicReader(gizmoReader)
	readersApp(t)

	// The same clause again is what a second app's Register does: no-op.
	RegisterPublicReader(gizmoReader)

	defer func() {
		if recover() == nil {
			t.Fatal("RegisterPublicReader with a new clause after the rules were composed must panic")
		}
	}()
	RegisterPublicReader(`@request.headers.x_share_token = "late"`)
}

// Register composes on serve even with no form hosts: a package's clause
// must not depend on whether any host is installed.
func TestPublicReaders_RegisterComposesOnServeWithNoHosts(t *testing.T) {
	resetPublicReaders(t)
	RegisterPublicReader(gizmoReader)
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })
	rlstest.Apply(t, app, rlstest.CoreMigrationsDir(t))
	Register(app, Options{})
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app}); err != nil {
		t.Fatal(err)
	}
	want := signedInReadRule + " || (" + gizmoReader + ")"
	for _, kind := range []string{"list", "view"} {
		if rule, _ := rlstest.Rule(t, app, formsCollection, kind); rule != want {
			t.Errorf("forms %s rule after serve = %q, want %q", kind, rule, want)
		}
	}
}

// With no forms collection there is nothing to compose onto: harmless with no
// clause, an error when a package expects its clause served.
func TestPublicReaders_AbsentCollectionFailsOnlyWithAClause(t *testing.T) {
	resetPublicReaders(t)
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := ApplyPublicReaders(app); err != nil {
		t.Fatalf("no clause, no collection: %v", err)
	}
	resetPublicReaders(t)
	RegisterPublicReader(gizmoReader)
	if err := ApplyPublicReaders(app); err == nil {
		t.Fatal("a registered clause with no forms collection to carry it must be an error")
	}
}
