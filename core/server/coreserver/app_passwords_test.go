package coreserver

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/rlstest"
)

func newAppPasswordsApp(t *testing.T) (*tests.TestApp, *core.Record, string) {
	t.Helper()
	app := rlstest.NewAssembledApp(t)
	registerAppPasswordsCore(app)

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.Set("email", "ada@test.local")
	user.Set("username", "ada")
	user.Set("name", "Ada")
	user.Set("role", "member")
	user.Set("password", "Password123!")
	if err := app.Save(user); err != nil {
		t.Fatalf("save user: %v", err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return app, user, token
}

func TestAppPasswordCreate_ReturnsPlaintextOnceAndStoresHash(t *testing.T) {
	app, user, token := newAppPasswordsApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "create app password",
		Method:                http.MethodPost,
		URL:                   "/api/account/app-passwords",
		Body:                  strings.NewReader(`{"name":"  Thunderbird  "}`),
		Headers:               map[string]string{"Authorization": token},
		ExpectedStatus:        http.StatusOK,
		ExpectedContent:       []string{`"password"`, `"record"`},
		NotExpectedContent:    []string{`"hash"`},
		TestAppFactory:        func(_ testing.TB) *tests.TestApp { return app },
		DisableTestAppCleanup: true,
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			body, _ := io.ReadAll(res.Body)
			var got struct {
				Password string `json:"password"`
				Record   struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"record"`
			}
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("decode: %v (%s)", err, body)
			}
			if !regexp.MustCompile(`^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$`).MatchString(got.Password) {
				t.Fatalf("password %q has the wrong format", got.Password)
			}
			if got.Record.Name != "Thunderbird" {
				t.Fatalf("name not trimmed: %q", got.Record.Name)
			}
			row, err := app.FindRecordById(authfactor.AppPasswordsCollection, got.Record.ID)
			if err != nil {
				t.Fatal(err)
			}
			if row.GetString("user") != user.Id {
				t.Fatal("row is not owned by the caller")
			}
			if row.GetString("hash") == got.Password || row.GetString("hash") != authfactor.HashAppPassword(got.Password) {
				t.Fatal("row must store the hash, not the plaintext")
			}
			if !authfactor.MatchAppPassword(app, user.Id, got.Password) {
				t.Fatal("the returned password does not sign in")
			}
		},
	}
	scenario.Test(t)
}

func TestAppPasswordCreate_Refusals(t *testing.T) {
	app, _, token := newAppPasswordsApp(t)

	cases := []struct {
		name    string
		body    string
		headers map[string]string
		status  int
	}{
		{"no auth", `{"name":"x"}`, nil, http.StatusUnauthorized},
		{"blank name", `{"name":"   "}`, map[string]string{"Authorization": token}, http.StatusBadRequest},
		{"long name", `{"name":"` + strings.Repeat("a", 101) + `"}`, map[string]string{"Authorization": token}, http.StatusBadRequest},
		{"bad json", `{`, map[string]string{"Authorization": token}, http.StatusBadRequest},
	}
	for _, c := range cases {
		scenario := &tests.ApiScenario{
			Name:                  c.name,
			Method:                http.MethodPost,
			URL:                   "/api/account/app-passwords",
			Body:                  strings.NewReader(c.body),
			Headers:               c.headers,
			ExpectedStatus:        c.status,
			ExpectedContent:       []string{`"message"`},
			TestAppFactory:        func(_ testing.TB) *tests.TestApp { return app },
			DisableTestAppCleanup: true,
		}
		scenario.Test(t)
	}
}

func TestAppPasswordCreate_SuperuserIsRefused(t *testing.T) {
	app, _, _ := newAppPasswordsApp(t)
	superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	su := core.NewRecord(superusers)
	su.Set("email", "root@test.local")
	su.Set("password", "Password123!")
	if err := app.Save(su); err != nil {
		t.Fatal(err)
	}
	token, err := su.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	scenario := &tests.ApiScenario{
		Name:                  "superuser refused",
		Method:                http.MethodPost,
		URL:                   "/api/account/app-passwords",
		Body:                  strings.NewReader(`{"name":"x"}`),
		Headers:               map[string]string{"Authorization": token},
		ExpectedStatus:        http.StatusUnauthorized,
		ExpectedContent:       []string{`"message"`},
		TestAppFactory:        func(_ testing.TB) *tests.TestApp { return app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// A password change rotates the tokenKey, which ends every session; the app
// passwords end with it.
func TestAppPasswords_RevokedWhenTheTokenKeyChanges(t *testing.T) {
	app, user, _ := newAppPasswordsApp(t)
	col, err := app.FindCollectionByNameOrId(authfactor.AppPasswordsCollection)
	if err != nil {
		t.Fatal(err)
	}
	display, hash, err := authfactor.GenerateAppPassword()
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", user.Id)
	row.Set("name", "Thunderbird")
	row.Set("hash", hash)
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}

	// An unrelated edit keeps them.
	fresh, _ := app.FindRecordById("users", user.Id)
	fresh.Set("name", "Ada L")
	if err := app.Save(fresh); err != nil {
		t.Fatal(err)
	}
	if !authfactor.MatchAppPassword(app, user.Id, display) {
		t.Fatal("an unrelated profile edit revoked the app password")
	}

	fresh, _ = app.FindRecordById("users", user.Id)
	fresh.SetPassword("AnotherPass123!")
	if err := app.Save(fresh); err != nil {
		t.Fatal(err)
	}
	if authfactor.MatchAppPassword(app, user.Id, display) {
		t.Fatal("the app password survived a password change")
	}
}
