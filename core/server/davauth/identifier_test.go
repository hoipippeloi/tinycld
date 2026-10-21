package davauth

import (
	"errors"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/authidentity"
)

// A protocol login takes a username or an address a package hosts. The
// account email is where invites and resets go, not a sign-in name.

func TestVerifyCredentials_AccountEmailIsNotASignInName(t *testing.T) {
	app := newAuthApp(t)
	newAuthUser(t, app, "alice@example.com", "Password123!", false)

	if _, err := VerifyCredentials(app, "alice", "Password123!"); err != nil {
		t.Fatalf("username refused: %v", err)
	}
	if _, err := VerifyCredentials(app, "alice@example.com", "Password123!"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("account email accepted as a sign-in name: err=%v", err)
	}
}

func TestVerifyCredentials_HostedAddressSignsIn(t *testing.T) {
	t.Cleanup(authidentity.ResetForTest)
	app := newAuthApp(t)
	alice := newAuthUser(t, app, "alice@example.com", "Password123!", false)

	// A fictional package that hosts @widgets.test addresses.
	authidentity.RegisterResolver("widgets", func(app core.App, address string) (*core.Record, error) {
		if address != "a.liddell@widgets.test" {
			return nil, nil
		}
		return app.FindRecordById("users", alice.Id)
	})

	got, err := VerifyCredentials(app, "a.liddell@widgets.test", "Password123!")
	if err != nil {
		t.Fatalf("hosted address refused: %v", err)
	}
	if got.Id != alice.Id {
		t.Fatalf("hosted address signed in as %s, want %s", got.Id, alice.Id)
	}
	if _, err := VerifyCredentials(app, "a.liddell@widgets.test", "wrong-password"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong password accepted: err=%v", err)
	}
	if _, err := VerifyCredentials(app, "nobody@widgets.test", "Password123!"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unknown address accepted: err=%v", err)
	}
}

func TestVerifyCredentials_ResolverErrorRefuses(t *testing.T) {
	t.Cleanup(authidentity.ResetForTest)
	app := newAuthApp(t)
	newAuthUser(t, app, "alice@example.com", "Password123!", false)
	authidentity.RegisterResolver("broken", func(core.App, string) (*core.Record, error) {
		return nil, errors.New("lookup failed")
	})

	_, err := VerifyCredentials(app, "alice@widgets.test", "Password123!")
	if !errors.Is(err, ErrUnauthorized) || strings.Contains(err.Error(), "lookup failed") {
		t.Fatalf("a failed lookup must look like any other refusal: err=%v", err)
	}
}
