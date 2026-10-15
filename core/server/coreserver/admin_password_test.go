package coreserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/rlstest"
)

// Account recovery by an owner or admin: a temporary password set through the
// users collection (manageRule + this guard), and a reset email sent to the
// member's own or another address.

type recoveryEnv struct {
	t   *testing.T
	app *tests.TestApp
	mux http.Handler
}

func newRecoveryEnv(t *testing.T) *recoveryEnv {
	t.Helper()
	adminResetLimiter.Reset()
	t.Setenv("TINYCLD_EMAIL_LOG", filepath.Join(t.TempDir(), "emails.log"))
	app := rlstest.NewAssembledApp(t)
	registerUsersFieldGuardCore(app)
	registerAppPasswordsCore(app)
	registerAdminPasswordResetCore(app)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	env := &recoveryEnv{t: t, app: app}
	err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}, func(e *core.ServeEvent) error {
		mux, err := e.Router.BuildMux()
		env.mux = mux
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func (env *recoveryEnv) user(email, role string) *core.Record {
	env.t.Helper()
	users, _ := env.app.FindCollectionByNameOrId("users")
	u := core.NewRecord(users)
	u.Set("email", email)
	u.Set("username", strings.Split(email, "@")[0])
	u.Set("name", "Test")
	u.Set("role", role)
	u.Set("password", "Password123!")
	if err := env.app.Save(u); err != nil {
		env.t.Fatalf("save user: %v", err)
	}
	return u
}

func (env *recoveryEnv) do(method, path string, body any, actor *core.Record) (int, string) {
	env.t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	if actor != nil {
		token, err := actor.NewAuthToken()
		if err != nil {
			env.t.Fatal(err)
		}
		req.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	env.mux.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func (env *recoveryEnv) setPassword(target, actor *core.Record) int {
	code, _ := env.do(http.MethodPatch, "/api/collections/users/records/"+target.Id,
		map[string]any{"password": "Temporary123!", "passwordConfirm": "Temporary123!"}, actor)
	return code
}

func TestAdminSetsTemporaryPassword(t *testing.T) {
	env := newRecoveryEnv(t)
	owner := env.user("owner@test.local", "owner")
	admin := env.user("admin@test.local", "admin")
	member := env.user("member@test.local", "member")
	other := env.user("other@test.local", "member")

	if code := env.setPassword(member, other); code == http.StatusOK {
		t.Fatal("a member set another member's password")
	}
	if code := env.setPassword(owner, admin); code == http.StatusOK {
		t.Fatal("an admin set an owner's password")
	}
	if code := env.setPassword(member, admin); code != http.StatusOK {
		t.Fatalf("admin set a member's password: %d", code)
	}

	fresh, _ := env.app.FindRecordById("users", member.Id)
	if !fresh.ValidatePassword("Temporary123!") {
		t.Fatal("password not changed")
	}
	if !authfactor.MustChangePassword(fresh) {
		t.Fatal("an admin-set password was not marked temporary")
	}

	// The client cannot clear the flag itself, even with its own session.
	if code, _ := env.do(http.MethodPatch, "/api/collections/users/records/"+member.Id,
		map[string]any{authfactor.MustChangePasswordField: false}, fresh); code == http.StatusOK {
		t.Fatal("a member cleared the flag without a new password")
	}

	// The member's own change ends it.
	fresh, _ = env.app.FindRecordById("users", member.Id)
	if code, body := env.do(http.MethodPatch, "/api/collections/users/records/"+member.Id, map[string]any{
		"oldPassword": "Temporary123!", "password": "MemberChose123!", "passwordConfirm": "MemberChose123!",
	}, fresh); code != http.StatusOK {
		t.Fatalf("member's own change: %d %s", code, body)
	}
	fresh, _ = env.app.FindRecordById("users", member.Id)
	if authfactor.MustChangePassword(fresh) {
		t.Fatal("flag survived the member's own change")
	}

	if code := env.setPassword(admin, owner); code != http.StatusOK {
		t.Fatalf("owner set an admin's password: %d", code)
	}
}

func TestAdminSendsPasswordReset(t *testing.T) {
	env := newRecoveryEnv(t)
	owner := env.user("owner@test.local", "owner")
	admin := env.user("admin@test.local", "admin")
	member := env.user("member@test.local", "member")
	path := func(u *core.Record) string { return "/api/admin/users/" + u.Id + "/password-reset/send" }

	if code, _ := env.do(http.MethodPost, path(member), map[string]any{}, member); code != http.StatusForbidden {
		t.Fatalf("member sent a reset: %d", code)
	}
	if code, _ := env.do(http.MethodPost, path(owner), map[string]any{}, admin); code != http.StatusForbidden {
		t.Fatalf("admin sent an owner's reset: %d", code)
	}
	if code, _ := env.do(http.MethodPost, path(admin), map[string]any{}, admin); code != http.StatusBadRequest {
		t.Fatalf("admin sent their own reset here: %d", code)
	}
	if code, _ := env.do(http.MethodPost, path(member), map[string]any{"email": "not an address"}, admin); code != http.StatusBadRequest {
		t.Fatalf("bad address accepted: %d", code)
	}

	code, body := env.do(http.MethodPost, path(member), map[string]any{}, admin)
	if code != http.StatusOK || !strings.Contains(body, "member@test.local") {
		t.Fatalf("reset to own email: %d %s", code, body)
	}
	code, body = env.do(http.MethodPost, path(member), map[string]any{"email": "Personal <ada@elsewhere.test>"}, admin)
	if code != http.StatusOK || !strings.Contains(body, "ada@elsewhere.test") {
		t.Fatalf("reset to another address: %d %s", code, body)
	}

	log, err := os.ReadFile(os.Getenv("TINYCLD_EMAIL_LOG"))
	if err != nil {
		t.Fatalf("read email log: %v", err)
	}
	for _, want := range []string{"member@test.local", "ada@elsewhere.test", "/reset-password/"} {
		if !strings.Contains(string(log), want) {
			t.Fatalf("email log has no %q", want)
		}
	}
}
