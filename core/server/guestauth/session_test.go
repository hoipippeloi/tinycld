package guestauth

import (
	"errors"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/rlstest"
)

// An emailed code proves only that the visitor reads the mailbox. These pin
// the accounts for which that must not become a session: one with a second
// factor, and a member while the organization requires one.

func sessionUser(t *testing.T, app core.App, email, role string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.Set("email", email)
	u.Set("username", strings.Split(email, "@")[0])
	u.Set("name", "Test")
	u.Set("role", role)
	u.Set("password", "Password123!")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user: %v", err)
	}
	return u
}

func requireMFA(t *testing.T, app core.App) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("system_settings")
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("key", authfactor.RequireMFAKey)
	row.Set("value", "true")
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}
}

func TestNewSessionToken_GuestWithoutFactor(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	guest := sessionUser(t, app, "guest@test.local", GuestRole)
	if token, err := NewSessionToken(app, guest); err != nil || token == "" {
		t.Fatalf("guest refused: %v", err)
	}

	// The organization's requirement is for members; a guest who opened a
	// share link still gets in with the emailed code.
	requireMFA(t, app)
	if _, err := NewSessionToken(app, guest); err != nil {
		t.Fatalf("guest refused under require-MFA: %v", err)
	}
}

func TestNewSessionToken_RefusesAccountWithSecondFactor(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	member := sessionUser(t, app, "member@test.local", "member")
	col, err := app.FindCollectionByNameOrId(authfactor.TOTPCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", member.Id)
	row.Set("secret", "JBSWY3DPEHPK3PXP")
	row.Set("enabled_at", types.NowDateTime())
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}

	if _, err := NewSessionToken(app, member); !errors.Is(err, ErrFullSignInRequired) {
		t.Fatalf("an emailed code signed in an account with MFA: %v", err)
	}
}

func TestNewSessionToken_RefusesMemberWhenMFARequired(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	member := sessionUser(t, app, "member@test.local", "member")
	if _, err := NewSessionToken(app, member); err != nil {
		t.Fatalf("member refused before MFA was required: %v", err)
	}
	requireMFA(t, app)
	if _, err := NewSessionToken(app, member); !errors.Is(err, ErrFullSignInRequired) {
		t.Fatalf("an emailed code let a member skip required enrollment: %v", err)
	}
}
