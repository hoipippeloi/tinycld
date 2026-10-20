package authidentity_test

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/authidentity"
	"tinycld.org/core/rlstest"
)

func newSignInApp(t *testing.T) (*tests.TestApp, *core.Record) {
	t.Helper()
	t.Cleanup(authidentity.ResetForTest)
	app := rlstest.NewAssembledApp(t)
	authidentity.Register(app)

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	alice := core.NewRecord(users)
	alice.Set("email", "alice@example.com")
	alice.Set("username", "alice")
	alice.Set("name", "Alice")
	alice.Set("role", "member")
	alice.Set("password", "Password123!")
	if err := app.Save(alice); err != nil {
		t.Fatalf("save user: %v", err)
	}
	// A fictional package that hosts @widgets.test addresses.
	authidentity.RegisterResolver("widgets", func(app core.App, address string) (*core.Record, error) {
		if address != "a.liddell@widgets.test" {
			return nil, nil
		}
		return app.FindRecordById("users", alice.Id)
	})
	return app, alice
}

func signIn(t *testing.T, app *tests.TestApp, identity string, status int, content ...string) {
	t.Helper()
	scenario := &tests.ApiScenario{
		Name:                  "sign in as " + identity,
		Method:                http.MethodPost,
		URL:                   "/api/collections/users/auth-with-password",
		Body:                  strings.NewReader(`{"identity":"` + identity + `","password":"Password123!"}`),
		ExpectedStatus:        status,
		ExpectedContent:       content,
		TestAppFactory:        func(testing.TB) *tests.TestApp { return app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

func TestSignInWithUsernameOrHostedAddress(t *testing.T) {
	app, alice := newSignInApp(t)

	signIn(t, app, "alice", http.StatusOK, `"token"`, alice.Id)
	signIn(t, app, "a.liddell@widgets.test", http.StatusOK, `"token"`, alice.Id)
}

// The account email reaches the person; it does not sign them in.
func TestSignInRefusesTheAccountEmail(t *testing.T) {
	app, _ := newSignInApp(t)

	signIn(t, app, "alice@example.com", http.StatusBadRequest, "Failed to authenticate")
	signIn(t, app, "nobody@widgets.test", http.StatusBadRequest, "Failed to authenticate")
}

func TestResolveAsksResolversInNameOrder(t *testing.T) {
	t.Cleanup(authidentity.ResetForTest)
	app := rlstest.NewAssembledApp(t)
	first := core.NewRecord(core.NewBaseCollection("x"))
	first.Id = "first"
	second := core.NewRecord(core.NewBaseCollection("x"))
	second.Id = "second"

	authidentity.RegisterResolver("zeta", func(core.App, string) (*core.Record, error) { return second, nil })
	authidentity.RegisterResolver("alpha", func(core.App, string) (*core.Record, error) { return first, nil })

	got, err := authidentity.Resolve(app, "x@y.test")
	if err != nil || got != first {
		t.Fatalf("Resolve = %v, %v; want the alpha resolver's record", got, err)
	}
	if got, err := authidentity.Resolve(app, "alice"); got != nil || err != nil {
		t.Fatalf("a username is not an address: Resolve = %v, %v", got, err)
	}
}

func TestResolveReportsALookupError(t *testing.T) {
	t.Cleanup(authidentity.ResetForTest)
	app := rlstest.NewAssembledApp(t)
	broken := errors.New("lookup failed")
	authidentity.RegisterResolver("broken", func(core.App, string) (*core.Record, error) { return nil, broken })

	if _, err := authidentity.Resolve(app, "x@y.test"); !errors.Is(err, broken) {
		t.Fatalf("Resolve error = %v, want %v", err, broken)
	}
}
