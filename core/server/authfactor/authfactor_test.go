package authfactor

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"tinycld.org/core/rlstest"
)

func newUser(t *testing.T, app core.App, email string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.Set("email", email)
	u.Set("username", strings.Split(email, "@")[0])
	u.Set("name", "Test User")
	u.Set("role", "member")
	u.Set("password", "Password123!")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user: %v", err)
	}
	return u
}

func saveAppPassword(t *testing.T, app core.App, userID string) (string, *core.Record) {
	t.Helper()
	display, hash, err := GenerateAppPassword()
	if err != nil {
		t.Fatal(err)
	}
	col, err := app.FindCollectionByNameOrId(AppPasswordsCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", userID)
	row.Set("name", "Laptop")
	row.Set("hash", hash)
	if err := app.Save(row); err != nil {
		t.Fatalf("save app password: %v", err)
	}
	return display, row
}

func TestGenerateAppPassword_Format(t *testing.T) {
	display, hash, err := GenerateAppPassword()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$`).MatchString(display) {
		t.Fatalf("display %q is not four groups of four letters", display)
	}
	if hash != HashAppPassword(display) {
		t.Fatal("returned hash does not match the display value")
	}
	other, _, _ := GenerateAppPassword()
	if other == display {
		t.Fatal("two generated passwords are equal")
	}
}

func TestHashAppPassword_IgnoresCaseAndSeparators(t *testing.T) {
	want := HashAppPassword("abcd efgh ijkl mnop")
	for _, typed := range []string{"abcdefghijklmnop", "ABCD-EFGH-IJKL-MNOP", "AbCd EfGh IjKl MnOp"} {
		if HashAppPassword(typed) != want {
			t.Errorf("%q hashes differently from the display form", typed)
		}
	}
}

func TestMatchAppPassword(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	alice := newUser(t, app, "alice@example.com")
	bob := newUser(t, app, "bob@example.com")
	display, _ := saveAppPassword(t, app, alice.Id)

	if !MatchAppPassword(app, alice.Id, display) {
		t.Fatal("own app password did not match")
	}
	if !MatchAppPassword(app, alice.Id, strings.ToUpper(strings.ReplaceAll(display, " ", ""))) {
		t.Fatal("app password typed without spaces in upper case did not match")
	}
	if MatchAppPassword(app, bob.Id, display) {
		t.Fatal("another user's app password matched")
	}
	if MatchAppPassword(app, alice.Id, "Password123!") {
		t.Fatal("the account password matched as an app password")
	}
	if MatchAppPassword(app, "", display) {
		t.Fatal("an empty user id matched")
	}
}

func TestMatchAppPassword_RecordsLastUsedHourly(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	alice := newUser(t, app, "alice@example.com")
	display, row := saveAppPassword(t, app, alice.Id)

	if !MatchAppPassword(app, alice.Id, display) {
		t.Fatal("no match")
	}
	first := reload(t, app, row.Id).GetDateTime("last_used")
	if first.IsZero() {
		t.Fatal("last_used was not set on first use")
	}

	// A second use inside the hour does not write again.
	if !MatchAppPassword(app, alice.Id, display) {
		t.Fatal("no match")
	}
	if got := reload(t, app, row.Id).GetDateTime("last_used"); !got.Equal(first) {
		t.Fatalf("last_used rewritten within the hour: %v -> %v", first, got)
	}

	stale := reload(t, app, row.Id)
	old, _ := types.ParseDateTime(time.Now().Add(-2 * time.Hour))
	stale.Set("last_used", old)
	if err := app.SaveNoValidate(stale); err != nil {
		t.Fatal(err)
	}
	if !MatchAppPassword(app, alice.Id, display) {
		t.Fatal("no match")
	}
	if got := reload(t, app, row.Id).GetDateTime("last_used"); !got.After(old) {
		t.Fatalf("last_used not refreshed after two hours: %v", got)
	}
}

func TestHasSecondFactor(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	alice := newUser(t, app, "alice@example.com")

	if HasSecondFactor(app, alice.Id) {
		t.Fatal("a new user reports a second factor")
	}

	// An app password is not a second factor: it replaces the account
	// password for protocol clients, it does not add to it.
	saveAppPassword(t, app, alice.Id)
	if HasSecondFactor(app, alice.Id) {
		t.Fatal("an app password counted as a second factor")
	}
	if HasSecondFactor(app, "") {
		t.Fatal("an empty user id reports a second factor")
	}
}

func TestAppPasswordsShippedRules(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	const own = "user = @request.auth.id"
	rlstest.RequireRuleContains(t, app, AppPasswordsCollection, "list", own)
	rlstest.RequireRuleContains(t, app, AppPasswordsCollection, "view", own)
	rlstest.RequireRuleContains(t, app, AppPasswordsCollection, "delete", own)
	for _, kind := range []string{"create", "update"} {
		if rule, ok := rlstest.Rule(t, app, AppPasswordsCollection, kind); ok {
			t.Fatalf("app_passwords %s rule must be locked (nil), got %q", kind, rule)
		}
	}
	col, err := app.FindCollectionByNameOrId(AppPasswordsCollection)
	if err != nil {
		t.Fatal(err)
	}
	if f := col.Fields.GetByName("hash"); f == nil || !f.GetHidden() {
		t.Fatal("app_passwords.hash must be a hidden field")
	}
}

func reload(t *testing.T, app core.App, id string) *core.Record {
	t.Helper()
	r, err := app.FindRecordById(AppPasswordsCollection, id)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestHasSecondFactor_ConfirmedTOTPAndPasskeysCount(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	alice := newUser(t, app, "alice@example.com")
	bob := newUser(t, app, "bob@example.com")

	totpCol, err := app.FindCollectionByNameOrId(TOTPCollection)
	if err != nil {
		t.Fatal(err)
	}
	pending := core.NewRecord(totpCol)
	pending.Set("user", alice.Id)
	pending.Set("secret", "JBSWY3DPEHPK3PXP")
	if err := app.Save(pending); err != nil {
		t.Fatal(err)
	}
	if HasSecondFactor(app, alice.Id) {
		t.Fatal("an unconfirmed authenticator setup counted as a factor")
	}
	pending.Set("enabled_at", types.NowDateTime())
	if err := app.Save(pending); err != nil {
		t.Fatal(err)
	}
	if !HasSecondFactor(app, alice.Id) {
		t.Fatal("a confirmed authenticator app did not count")
	}

	passkeyCol, err := app.FindCollectionByNameOrId(PasskeysCollection)
	if err != nil {
		t.Fatal(err)
	}
	pk := core.NewRecord(passkeyCol)
	pk.Set("user", bob.Id)
	pk.Set("name", "Phone")
	pk.Set("credential_id", "cred-1")
	pk.Set("credential", map[string]any{"id": "cred-1"})
	if err := app.Save(pk); err != nil {
		t.Fatal(err)
	}
	if !HasSecondFactor(app, bob.Id) {
		t.Fatal("a passkey did not count")
	}
}
