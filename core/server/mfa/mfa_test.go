package mfa

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pquerna/otp/totp"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/rlstest"
)

const testPassword = "Password123!"

// harness serves the app's real router, with this package's hooks and routes
// bound, so a test drives sign-in exactly as a client does.
type harness struct {
	t   *testing.T
	app *tests.TestApp
	mux http.Handler
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	app := rlstest.NewAssembledApp(t)
	Register(app)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, app: app}
	ev := &core.ServeEvent{App: app, Router: router}
	err = app.OnServe().Trigger(ev, func(e *core.ServeEvent) error {
		mux, err := e.Router.BuildMux()
		h.mux = mux
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

type response struct {
	status int
	body   map[string]any
}

func (r response) str(key string) string {
	s, _ := r.body[key].(string)
	return s
}

func (h *harness) do(method, url string, body any, token string) response {
	h.t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, url, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	out := response{status: rec.Code, body: map[string]any{}}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	return out
}

func (h *harness) user(email, role string) *core.Record {
	h.t.Helper()
	users, err := h.app.FindCollectionByNameOrId("users")
	if err != nil {
		h.t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.Set("email", email)
	u.Set("username", strings.Split(email, "@")[0])
	u.Set("name", "Test")
	u.Set("role", role)
	u.Set("password", testPassword)
	if err := h.app.Save(u); err != nil {
		h.t.Fatalf("save user: %v", err)
	}
	return u
}

func (h *harness) session(u *core.Record) string {
	h.t.Helper()
	token, err := u.NewAuthToken()
	if err != nil {
		h.t.Fatal(err)
	}
	return token
}

func (h *harness) passwordLogin(username string) response {
	return h.do(http.MethodPost, "/api/collections/users/auth-with-password",
		map[string]any{"identity": username, "password": testPassword}, "")
}

// enroll turns on TOTP for u through the routes and returns the secret and
// the recovery codes.
func (h *harness) enroll(u *core.Record) (string, []string) {
	h.t.Helper()
	token := h.session(u)
	begin := h.do(http.MethodPost, "/api/account/mfa/totp/begin", nil, token)
	if begin.status != http.StatusOK {
		h.t.Fatalf("begin: %d %v", begin.status, begin.body)
	}
	secret := begin.str("secret")
	confirm := h.do(http.MethodPost, "/api/account/mfa/totp/confirm",
		map[string]any{"code": codeAt(h.t, secret, time.Now())}, token)
	if confirm.status != http.StatusOK {
		h.t.Fatalf("confirm: %d %v", confirm.status, confirm.body)
	}
	return secret, toStrings(confirm.body["recoveryCodes"])
}

func codeAt(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	code, err := totp.GenerateCode(secret, at)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// nextCode is the code for the following step. The step enrollment used is
// spent (replay protection), so a sign-in right after enrolling uses the
// next one, which the skew window still accepts.
func nextCode(t *testing.T, secret string) string {
	return codeAt(t, secret, time.Now().Add(totpPeriod*time.Second))
}

func toStrings(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, _ := item.(string)
		out = append(out, s)
	}
	return out
}

func TestMatchStep_SkewAndLength(t *testing.T) {
	key, err := newTOTPKey("example.com", "a@example.com")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, offset := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		if _, ok := matchStep(key.Secret(), codeAt(t, key.Secret(), now.Add(offset)), now); !ok {
			t.Errorf("code at offset %v refused", offset)
		}
	}
	if _, ok := matchStep(key.Secret(), codeAt(t, key.Secret(), now.Add(-90*time.Second)), now); ok {
		t.Error("code three steps old accepted")
	}
	if _, ok := matchStep(key.Secret(), "12345", now); ok {
		t.Error("five-digit code accepted")
	}
}

func TestGate_NoFactorSignsInWithPassword(t *testing.T) {
	h := newHarness(t)
	h.user("ada@test.local", "member")

	res := h.passwordLogin("ada")
	if res.status != http.StatusOK || res.str("token") == "" {
		t.Fatalf("password sign-in without MFA: %d %v", res.status, res.body)
	}
}

func TestGate_TOTPRequiresSecondStep(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)

	first := h.passwordLogin("ada")
	if first.status != http.StatusUnauthorized || first.str("token") != "" {
		t.Fatalf("password alone must not sign in: %d %v", first.status, first.body)
	}
	mfaToken := first.str("mfaToken")
	if mfaToken == "" {
		t.Fatalf("no mfaToken: %v", first.body)
	}
	if got := toStrings(first.body["methods"]); strings.Join(got, ",") != "totp,recovery" {
		t.Fatalf("methods = %v", got)
	}

	// The pending token is not a session.
	if res := h.do(http.MethodPost, "/api/collections/users/auth-refresh", nil, mfaToken); res.status == http.StatusOK {
		t.Fatal("a pending token refreshed into a session")
	}

	code := nextCode(t, secret)
	wrong := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": "000000"}, "")
	if wrong.status != http.StatusBadRequest {
		t.Fatalf("wrong code: %d %v", wrong.status, wrong.body)
	}
	ok := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": code}, "")
	if ok.status != http.StatusOK || ok.str("token") == "" {
		t.Fatalf("verify: %d %v", ok.status, ok.body)
	}

	replay := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": code}, "")
	if replay.status != http.StatusBadRequest {
		t.Fatalf("a used code was accepted again: %d", replay.status)
	}

	// A session from the second step refreshes without being asked again.
	refreshed := h.do(http.MethodPost, "/api/collections/users/auth-refresh", nil, ok.str("token"))
	if refreshed.status != http.StatusOK {
		t.Fatalf("refresh after MFA: %d %v", refreshed.status, refreshed.body)
	}
}

func TestVerify_RecoveryCodeIsSingleUse(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	_, codes := h.enroll(ada)
	if len(codes) != recoveryCodeCount {
		t.Fatalf("got %d recovery codes", len(codes))
	}

	mfaToken := h.passwordLogin("ada").str("mfaToken")
	typed := strings.ToUpper(strings.ReplaceAll(codes[3], "-", ""))
	ok := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "recoveryCode": typed}, "")
	if ok.status != http.StatusOK || ok.str("token") == "" {
		t.Fatalf("recovery sign-in: %d %v", ok.status, ok.body)
	}
	again := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "recoveryCode": codes[3]}, "")
	if again.status != http.StatusBadRequest {
		t.Fatalf("a used recovery code was accepted again: %d", again.status)
	}

	row, err := findTOTP(h.app, ada.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := row.GetInt("recovery_remaining"); got != recoveryCodeCount-1 {
		t.Fatalf("recovery_remaining = %d", got)
	}
}

func TestVerify_PendingTokenDiesWithTokenKey(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)
	mfaToken := h.passwordLogin("ada").str("mfaToken")

	fresh, err := h.app.FindRecordById("users", ada.Id)
	if err != nil {
		t.Fatal(err)
	}
	fresh.RefreshTokenKey()
	if err := h.app.Save(fresh); err != nil {
		t.Fatal(err)
	}

	res := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": nextCode(t, secret)}, "")
	if res.status != http.StatusUnauthorized {
		t.Fatalf("pending token survived sign-out everywhere: %d", res.status)
	}
}

func TestVerify_RateLimited(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)
	codeLimiter.For(h.app).Reset()
	mfaToken := h.passwordLogin("ada").str("mfaToken")

	for i := 0; i < 10; i++ {
		h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": "000000"}, "")
	}
	res := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": mfaToken, "code": nextCode(t, secret)}, "")
	if res.status != http.StatusTooManyRequests {
		t.Fatalf("eleventh attempt: %d", res.status)
	}
}

func TestRequireMFA_EnrollsDuringSignIn(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	setRequireMFA(t, h.app, "true")

	first := h.passwordLogin("ada")
	enrollToken := first.str("mfaEnrollToken")
	if first.status != http.StatusUnauthorized || enrollToken == "" || first.str("token") != "" {
		t.Fatalf("expected an enroll step: %d %v", first.status, first.body)
	}

	// The enroll token reaches only the enrollment routes.
	if res := h.do(http.MethodPost, "/api/auth/mfa/verify", map[string]any{"mfaToken": enrollToken, "code": "000000"}, ""); res.status != http.StatusUnauthorized {
		t.Fatalf("enroll token accepted as a verify token: %d", res.status)
	}
	if res := h.do(http.MethodPost, "/api/account/mfa/totp/disable", map[string]any{"code": "000000"}, enrollToken); res.status != http.StatusUnauthorized {
		t.Fatalf("enroll token accepted as a session: %d", res.status)
	}

	begin := h.do(http.MethodPost, "/api/account/mfa/totp/begin", map[string]any{"mfaEnrollToken": enrollToken}, "")
	if begin.status != http.StatusOK {
		t.Fatalf("begin with enroll token: %d %v", begin.status, begin.body)
	}
	confirm := h.do(http.MethodPost, "/api/account/mfa/totp/confirm", map[string]any{
		"mfaEnrollToken": enrollToken,
		"code":           codeAt(t, begin.str("secret"), time.Now()),
	}, "")
	if confirm.status != http.StatusOK || confirm.str("token") == "" {
		t.Fatalf("confirm with enroll token must sign in: %d %v", confirm.status, confirm.body)
	}
	meta, _ := confirm.body["meta"].(map[string]any)
	if len(toStrings(meta["recoveryCodes"])) != recoveryCodeCount {
		t.Fatalf("recovery codes missing from the sign-in response: %v", confirm.body)
	}
	if !authfactor.HasSecondFactor(h.app, ada.Id) {
		t.Fatal("enrollment did not record a factor")
	}
}

func TestDisable_RefusedWhenRequiredAndNoOtherFactor(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)
	setRequireMFA(t, h.app, "true")

	res := h.do(http.MethodPost, "/api/account/mfa/totp/disable", map[string]any{"code": nextCode(t, secret)}, h.session(ada))
	if res.status != http.StatusBadRequest {
		t.Fatalf("disable under require-MFA with no passkey: %d", res.status)
	}
	if !authfactor.HasSecondFactor(h.app, ada.Id) {
		t.Fatal("factor removed")
	}
}

func TestDisable_NeedsAValidCode(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)
	token := h.session(ada)

	if res := h.do(http.MethodPost, "/api/account/mfa/totp/disable", map[string]any{"code": "000000"}, token); res.status != http.StatusBadRequest {
		t.Fatalf("disable with a wrong code: %d", res.status)
	}
	if res := h.do(http.MethodPost, "/api/account/mfa/totp/disable", map[string]any{"code": nextCode(t, secret)}, token); res.status != http.StatusOK {
		t.Fatalf("disable: %d %v", res.status, res.body)
	}
	if authfactor.HasSecondFactor(h.app, ada.Id) {
		t.Fatal("factor still present")
	}
	if res := h.passwordLogin("ada"); res.status != http.StatusOK {
		t.Fatalf("password sign-in after disable: %d", res.status)
	}
}

// The recovery reset is a collection delete under the rules: an owner or
// admin may remove another member's factors, never their own (that needs a
// code), and an admin never an owner's.
func TestAdminReset_ThroughTheCollectionRules(t *testing.T) {
	h := newHarness(t)
	owner := h.user("owner@test.local", "owner")
	admin := h.user("admin@test.local", "admin")
	member := h.user("member@test.local", "member")
	h.enroll(owner)
	h.enroll(admin)
	h.enroll(member)

	del := func(target *core.Record, actor *core.Record) int {
		row, err := findTOTP(h.app, target.Id)
		if err != nil {
			t.Fatal(err)
		}
		return h.do(http.MethodDelete, "/api/collections/mfa_totp/records/"+row.Id, nil, h.session(actor)).status
	}
	if code := del(member, member); code == http.StatusNoContent {
		t.Fatal("a member removed their own authenticator without a code")
	}
	if code := del(admin, admin); code == http.StatusNoContent {
		t.Fatal("an admin removed their own authenticator without a code")
	}
	if code := del(owner, admin); code == http.StatusNoContent {
		t.Fatal("an admin removed an owner's authenticator")
	}
	if code := del(member, admin); code != http.StatusNoContent {
		t.Fatalf("admin reset of a member: %d", code)
	}
	if authfactor.HasSecondFactor(h.app, member.Id) {
		t.Fatal("member still has a factor after reset")
	}
	if code := del(admin, owner); code != http.StatusNoContent {
		t.Fatalf("owner reset of an admin: %d", code)
	}
}

// An admin-set temporary password opens only the "choose a new password"
// step: no session, and the reset token it returns works once.
func TestGate_TemporaryPasswordMustBeChanged(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	ada.Set(authfactor.MustChangePasswordField, true)
	if err := h.app.Save(ada); err != nil {
		t.Fatal(err)
	}

	first := h.passwordLogin("ada")
	token := first.str("passwordResetToken")
	if first.status != http.StatusUnauthorized || token == "" || first.str("token") != "" {
		t.Fatalf("temporary password signed in: %d %v", first.status, first.body)
	}

	confirm := map[string]any{"token": token, "password": "ChosenByAda123!", "passwordConfirm": "ChosenByAda123!"}
	if r := h.do(http.MethodPost, "/api/collections/users/confirm-password-reset", confirm, ""); r.status != http.StatusNoContent {
		t.Fatalf("confirm: %d %v", r.status, r.body)
	}
	if r := h.do(http.MethodPost, "/api/collections/users/confirm-password-reset", confirm, ""); r.status == http.StatusNoContent {
		t.Fatal("the reset token worked twice")
	}
	fresh, _ := h.app.FindRecordById("users", ada.Id)
	if authfactor.MustChangePassword(fresh) {
		t.Fatal("the flag survived the member's own password")
	}
	login := h.do(http.MethodPost, "/api/collections/users/auth-with-password",
		map[string]any{"identity": "ada", "password": "ChosenByAda123!"}, "")
	if login.status != http.StatusOK || login.str("token") == "" {
		t.Fatalf("sign in with the new password: %d %v", login.status, login.body)
	}
}

// With a second factor, the factor comes first: a temporary password alone
// must not let its holder change the password.
func TestGate_TemporaryPasswordAfterTheSecondStep(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, _ := h.enroll(ada)
	fresh, _ := h.app.FindRecordById("users", ada.Id)
	fresh.Set(authfactor.MustChangePasswordField, true)
	if err := h.app.Save(fresh); err != nil {
		t.Fatal(err)
	}

	first := h.passwordLogin("ada")
	if first.str("passwordResetToken") != "" || first.str("mfaToken") == "" {
		t.Fatalf("password step skipped the second factor: %v", first.body)
	}
	verify := h.do(http.MethodPost, "/api/auth/mfa/verify",
		map[string]any{"mfaToken": first.str("mfaToken"), "code": nextCode(t, secret)}, "")
	if verify.status != http.StatusUnauthorized || verify.str("passwordResetToken") == "" || verify.str("token") != "" {
		t.Fatalf("after the code: %d %v", verify.status, verify.body)
	}
}

func TestMFATOTPShippedRules(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	rlstest.RequireRuleContains(t, app, authfactor.TOTPCollection, "list", "user = @request.auth.id")
	rlstest.RequireRuleContains(t, app, authfactor.TOTPCollection, "view", "user = @request.auth.id")
	// Only an owner or admin may delete, and never their own row.
	rlstest.RequireRuleContains(t, app, authfactor.TOTPCollection, "delete", "user != @request.auth.id")
	rlstest.RequireRuleContains(t, app, authfactor.TOTPCollection, "delete", `user.role != "owner"`)
	for _, kind := range []string{"create", "update"} {
		if rule, ok := rlstest.Rule(t, app, authfactor.TOTPCollection, kind); ok {
			t.Fatalf("mfa_totp %s rule must be locked (nil), got %q", kind, rule)
		}
	}
	col, err := app.FindCollectionByNameOrId(authfactor.TOTPCollection)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"secret", "recovery_codes", "last_step"} {
		if f := col.Fields.GetByName(name); f == nil || !f.GetHidden() {
			t.Errorf("mfa_totp.%s must be hidden", name)
		}
	}
}

func setRequireMFA(t *testing.T, app core.App, value string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(settingsTable)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("key", RequireMFAKey)
	row.Set("value", value)
	if err := app.Save(row); err != nil {
		t.Fatalf("save setting: %v", err)
	}
}

// Two requests racing with the same code must not both sign in.
func TestVerify_SameCodeRacingSignsInOnce(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local", "member")
	secret, codes := h.enroll(ada)
	code := nextCode(t, secret)

	for _, proof := range []map[string]any{{"code": code}, {"recoveryCode": codes[0]}} {
		const racers = 8
		results := make(chan int, racers)
		var tokens []string
		for i := 0; i < racers; i++ {
			tokens = append(tokens, h.passwordLogin("ada").str("mfaToken"))
		}
		var wg sync.WaitGroup
		for i := 0; i < racers; i++ {
			wg.Add(1)
			go func(token string) {
				defer wg.Done()
				body := map[string]any{"mfaToken": token}
				for k, v := range proof {
					body[k] = v
				}
				results <- h.do(http.MethodPost, "/api/auth/mfa/verify", body, "").status
			}(tokens[i])
		}
		wg.Wait()
		close(results)
		ok := 0
		for status := range results {
			if status == http.StatusOK {
				ok++
			}
		}
		if ok != 1 {
			t.Fatalf("%v: %d racing requests signed in, want exactly 1", proof, ok)
		}
		codeLimiter.For(h.app).Reset()
	}
}

func TestEnrollToken_RefusedOnceAFactorExists(t *testing.T) {
	h := newHarness(t)
	h.user("ada@test.local", "member")
	setRequireMFA(t, h.app, "true")
	enroll := h.passwordLogin("ada").str("mfaEnrollToken")

	begin := h.do(http.MethodPost, "/api/account/mfa/totp/begin", map[string]any{"mfaEnrollToken": enroll}, "")
	confirm := h.do(http.MethodPost, "/api/account/mfa/totp/confirm", map[string]any{
		"mfaEnrollToken": enroll,
		"code":           codeAt(t, begin.str("secret"), time.Now()),
	}, "")
	if confirm.status != http.StatusOK {
		t.Fatalf("confirm: %d %v", confirm.status, confirm.body)
	}
	if res := h.do(http.MethodPost, "/api/account/mfa/totp/begin", map[string]any{"mfaEnrollToken": enroll}, ""); res.status != http.StatusUnauthorized {
		t.Fatalf("a spent enroll token still works: %d", res.status)
	}
}

func TestRequireMFA_GuestsAreNotAskedToEnroll(t *testing.T) {
	h := newHarness(t)
	h.user("guest@test.local", "guest")
	setRequireMFA(t, h.app, "true")
	if res := h.passwordLogin("guest"); res.status != http.StatusOK {
		t.Fatalf("guest asked to enroll: %d %v", res.status, res.body)
	}
}
