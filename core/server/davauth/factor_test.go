package davauth

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/rlstest"
)

// Protocol clients cannot answer a second-factor prompt. These tests pin the
// rule that keeps them from being a way around MFA: an app password always
// works, and the account password works only while the account has no
// second factor.

func newFactorUser(t *testing.T, app core.App) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.Set("email", "ada@example.com")
	u.Set("username", "ada")
	u.Set("name", "Ada")
	u.Set("role", "member")
	u.Set("password", "Password123!")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user: %v", err)
	}
	return u
}

func addAppPassword(t *testing.T, app core.App, userID string) string {
	t.Helper()
	display, hash, err := authfactor.GenerateAppPassword()
	if err != nil {
		t.Fatal(err)
	}
	col, err := app.FindCollectionByNameOrId(authfactor.AppPasswordsCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", userID)
	row.Set("name", "Thunderbird")
	row.Set("hash", hash)
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}
	return display
}

func enableTOTP(t *testing.T, app core.App, userID string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(authfactor.TOTPCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", userID)
	row.Set("secret", "JBSWY3DPEHPK3PXP")
	row.Set("enabled_at", types.NowDateTime())
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyCredentials_AppPasswordWorksWithAndWithoutMFA(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	u := newFactorUser(t, app)
	appPassword := addAppPassword(t, app, u.Id)

	if _, err := VerifyCredentials(app, "ada", appPassword); err != nil {
		t.Fatalf("app password refused: %v", err)
	}

	enableTOTP(t, app, u.Id)
	if _, err := VerifyCredentials(app, "ada", appPassword); err != nil {
		t.Fatalf("app password refused after MFA was turned on: %v", err)
	}
}

func TestVerifyCredentials_AccountPasswordStopsWhenMFAIsOn(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	u := newFactorUser(t, app)

	if _, err := VerifyCredentials(app, "ada", "Password123!"); err != nil {
		t.Fatalf("account password refused without MFA: %v", err)
	}

	enableTOTP(t, app, u.Id)
	if _, err := VerifyCredentials(app, "ada", "Password123!"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("account password accepted with MFA on: %v", err)
	}
}

func TestVerifyCredentials_DisabledUserRefusedEvenWithAppPassword(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	u := newFactorUser(t, app)
	appPassword := addAppPassword(t, app, u.Id)
	u.Set("disabled", true)
	if err := app.Save(u); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCredentials(app, "ada", appPassword); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("disabled user signed in with an app password: %v", err)
	}
}
