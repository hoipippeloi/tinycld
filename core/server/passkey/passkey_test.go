package passkey

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/authfactor"
	"tinycld.org/core/mfa"
	"tinycld.org/core/nativeauth"
	"tinycld.org/core/rlstest"
)

const (
	testHost     = "example.test"
	testOrigin   = "https://" + testHost
	testPassword = "Password123!"
)

var b64 = base64.RawURLEncoding

// softKey is a minimal platform authenticator: one P-256 key, "none"
// attestation, user presence and user verification always set. It lets the
// tests run real ceremonies through go-webauthn instead of stubbing it.
type softKey struct {
	priv   *ecdsa.PrivateKey
	credID []byte
	handle []byte
	count  uint32
}

func newSoftKey(t *testing.T) *softKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	return &softKey{priv: priv, credID: id}
}

func (k *softKey) authData(t *testing.T, rpID string, attested bool) []byte {
	t.Helper()
	rpHash := sha256.Sum256([]byte(rpID))
	flags := byte(0x01 | 0x04) // user present, user verified
	if attested {
		flags |= 0x40
	}
	out := append([]byte{}, rpHash[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, k.count)
	if !attested {
		return out
	}
	out = append(out, make([]byte, 16)...) // AAGUID
	out = binary.BigEndian.AppendUint16(out, uint16(len(k.credID)))
	out = append(out, k.credID...)
	// Uncompressed point: 0x04 || X || Y, 32 bytes each for P-256.
	point, err := k.priv.PublicKey.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	cose, err := webauthncbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: point[1:33], -3: point[33:]})
	if err != nil {
		t.Fatal(err)
	}
	return append(out, cose...)
}

func clientData(t *testing.T, kind, challenge, origin string) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"type": kind, "challenge": challenge, "origin": origin})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// create answers a registration's options as navigator.credentials.create
// would, and remembers the user handle for later discoverable sign-ins.
func (k *softKey) create(t *testing.T, options map[string]any) map[string]any {
	t.Helper()
	user, _ := options["user"].(map[string]any)
	handle, err := b64.DecodeString(user["id"].(string))
	if err != nil {
		t.Fatalf("user id: %v", err)
	}
	k.handle = handle
	att, err := webauthncbor.Marshal(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": k.authData(t, options["rp"].(map[string]any)["id"].(string), true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"id":    b64.EncodeToString(k.credID),
		"rawId": b64.EncodeToString(k.credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(clientData(t, "webauthn.create", options["challenge"].(string), testOrigin)),
			"attestationObject": b64.EncodeToString(att),
		},
		"clientExtensionResults": map[string]any{},
	}
}

// get answers a sign-in's options as navigator.credentials.get would.
func (k *softKey) get(t *testing.T, options map[string]any, origin string) map[string]any {
	t.Helper()
	k.count++
	auth := k.authData(t, options["rpId"].(string), false)
	cdj := clientData(t, "webauthn.get", options["challenge"].(string), origin)
	cdHash := sha256.Sum256(cdj)
	digest := sha256.Sum256(append(append([]byte{}, auth...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"id":    b64.EncodeToString(k.credID),
		"rawId": b64.EncodeToString(k.credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cdj),
			"authenticatorData": b64.EncodeToString(auth),
			"signature":         b64.EncodeToString(sig),
			"userHandle":        b64.EncodeToString(k.handle),
		},
		"clientExtensionResults": map[string]any{},
	}
}

type harness struct {
	t   *testing.T
	app *tests.TestApp
	mux http.Handler
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	loginLimiter.Reset()
	app := rlstest.NewAssembledApp(t)
	mfa.Register(app)
	registerCore(app)
	nativeauth.Register(app)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, app: app}
	err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}, func(e *core.ServeEvent) error {
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

func (r response) obj(key string) map[string]any {
	m, _ := r.body[key].(map[string]any)
	return m
}

func (h *harness) do(path string, body any, token string) response {
	return h.doFrom(testOrigin, path, body, token)
}

func (h *harness) doFrom(origin, path string, body any, token string) response {
	h.t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "https://"+testHost+path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	out := response{status: rec.Code, body: map[string]any{}}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	return out
}

func (h *harness) user(email string) *core.Record {
	h.t.Helper()
	users, err := h.app.FindCollectionByNameOrId("users")
	if err != nil {
		h.t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.Set("email", email)
	u.Set("username", strings.Split(email, "@")[0])
	u.Set("name", "Test")
	u.Set("role", "member")
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

// register adds key as a passkey for the holder of token (a session), or of
// the extra body fields (an enroll token or a native ticket).
func (h *harness) register(key *softKey, token string, extra map[string]any) response {
	h.t.Helper()
	begin := h.do("/api/account/passkeys/register/begin", extra, token)
	if begin.status != http.StatusOK {
		h.t.Fatalf("register begin: %d %v", begin.status, begin.body)
	}
	body := map[string]any{
		"sessionToken": begin.str("sessionToken"),
		"name":         "Laptop",
		"credential":   key.create(h.t, begin.obj("options")),
	}
	for k, v := range extra {
		body[k] = v
	}
	return h.do("/api/account/passkeys/register/finish", body, token)
}

func (h *harness) login(key *softKey) response {
	h.t.Helper()
	begin := h.do("/api/auth/passkey/login/begin", nil, "")
	if begin.status != http.StatusOK {
		h.t.Fatalf("login begin: %d %v", begin.status, begin.body)
	}
	return h.do("/api/auth/passkey/login/finish", map[string]any{
		"sessionToken": begin.str("sessionToken"),
		"credential":   key.get(h.t, begin.obj("options"), testOrigin),
	}, "")
}

func TestRegisterAndSignIn(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	key := newSoftKey(t)

	reg := h.register(key, h.session(ada), nil)
	if reg.status != http.StatusOK {
		t.Fatalf("register finish: %d %v", reg.status, reg.body)
	}
	record := reg.obj("record")
	if _, leaked := record["credential"]; leaked {
		t.Fatal("the stored credential was returned to the client")
	}
	if !authfactor.HasSecondFactor(h.app, ada.Id) {
		t.Fatal("a passkey did not count as a second factor")
	}

	res := h.login(key)
	if res.status != http.StatusOK || res.str("token") == "" {
		t.Fatalf("passkey sign-in: %d %v", res.status, res.body)
	}
	if got := res.obj("record")["id"]; got != ada.Id {
		t.Fatalf("signed in as %v", got)
	}

	row, err := h.app.FindRecordById(authfactor.PasskeysCollection, record["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if row.GetDateTime("last_used").IsZero() {
		t.Fatal("last_used not recorded")
	}
}

func TestLogin_SessionTokenIsSingleUse(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	key := newSoftKey(t)
	h.register(key, h.session(ada), nil)

	begin := h.do("/api/auth/passkey/login/begin", nil, "")
	body := map[string]any{
		"sessionToken": begin.str("sessionToken"),
		"credential":   key.get(t, begin.obj("options"), testOrigin),
	}
	if res := h.do("/api/auth/passkey/login/finish", body, ""); res.status != http.StatusOK {
		t.Fatalf("first finish: %d %v", res.status, res.body)
	}
	if res := h.do("/api/auth/passkey/login/finish", body, ""); res.status != http.StatusBadRequest {
		t.Fatalf("a replayed assertion was accepted: %d", res.status)
	}
}

func TestLogin_RefusesAnotherOrigin(t *testing.T) {
	h := newHarness(t)
	// A client-sent X-Forwarded-Host is ignored unless the admin trusts it.
	req := httptest.NewRequest(http.MethodPost, "https://"+testHost+"/api/auth/passkey/login/begin", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an untrusted X-Forwarded-Host picked the relying party: %d", rec.Code)
	}

	if res := h.doFrom("https://evil.example", "/api/auth/passkey/login/begin", nil, ""); res.status != http.StatusBadRequest {
		t.Fatalf("begin from another origin: %d", res.status)
	}
	if res := h.doFrom("http://"+testHost, "/api/auth/passkey/login/begin", nil, ""); res.status != http.StatusBadRequest {
		t.Fatalf("begin over plain http: %d", res.status)
	}
}

func TestLogin_UnknownPasskeyRefused(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	stranger := newSoftKey(t)
	stranger.handle = []byte(ada.Id)

	if res := h.login(stranger); res.status != http.StatusBadRequest {
		t.Fatalf("an unregistered passkey signed in: %d %v", res.status, res.body)
	}
}

func TestPasskeyAsSecondStep(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	key := newSoftKey(t)
	h.register(key, h.session(ada), nil)

	first := h.do("/api/collections/users/auth-with-password",
		map[string]any{"identity": "ada", "password": testPassword}, "")
	mfaToken := first.str("mfaToken")
	if first.status != http.StatusUnauthorized || mfaToken == "" {
		t.Fatalf("password alone signed in with a passkey on file: %d %v", first.status, first.body)
	}
	methods, _ := first.body["methods"].([]any)
	if len(methods) != 1 || methods[0] != "passkey" {
		t.Fatalf("methods = %v", methods)
	}

	begin := h.do("/api/auth/mfa/passkey/begin", map[string]any{"mfaToken": mfaToken}, "")
	if begin.status != http.StatusOK {
		t.Fatalf("second-step begin: %d %v", begin.status, begin.body)
	}
	res := h.do("/api/auth/mfa/passkey/finish", map[string]any{
		"mfaToken":     mfaToken,
		"sessionToken": begin.str("sessionToken"),
		"credential":   key.get(t, begin.obj("options"), testOrigin),
	}, "")
	if res.status != http.StatusOK || res.str("token") == "" {
		t.Fatalf("second-step finish: %d %v", res.status, res.body)
	}
}

func TestRequiredEnrollmentWithPasskey(t *testing.T) {
	h := newHarness(t)
	h.user("ada@test.local")
	settings, err := h.app.FindCollectionByNameOrId("system_settings")
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(settings)
	row.Set("key", mfa.RequireMFAKey)
	row.Set("value", "true")
	if err := h.app.Save(row); err != nil {
		t.Fatal(err)
	}

	first := h.do("/api/collections/users/auth-with-password",
		map[string]any{"identity": "ada", "password": testPassword}, "")
	enroll := first.str("mfaEnrollToken")
	if enroll == "" {
		t.Fatalf("no enroll step: %d %v", first.status, first.body)
	}
	res := h.register(newSoftKey(t), "", map[string]any{"mfaEnrollToken": enroll})
	if res.status != http.StatusOK || res.str("token") == "" {
		t.Fatalf("enrolling a passkey must finish the sign-in: %d %v", res.status, res.body)
	}
}

func TestNativeHandoff(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	session := h.session(ada)

	// Registration in the browser sheet, authorized by a ticket.
	ticket := h.do("/api/auth/native/ticket", nil, session).str("ticket")
	if ticket == "" {
		t.Fatal("no ticket")
	}
	key := newSoftKey(t)
	if res := h.register(key, "", map[string]any{"ticket": ticket}); res.status != http.StatusOK {
		t.Fatalf("register with ticket: %d %v", res.status, res.body)
	}
	// One ticket, one passkey: a copy of the URL cannot add another.
	if res := h.register(newSoftKey(t), "", map[string]any{"ticket": ticket}); res.status != http.StatusUnauthorized {
		t.Fatalf("a spent ticket registered a second passkey: %d %v", res.status, res.body)
	}

	// Sign-in in the browser sheet, then the code exchange.
	signedIn := h.login(key).str("token")
	verifier := "a-verifier-long-enough-to-be-a-real-pkce-verifier-value"
	sum := sha256.Sum256([]byte(verifier))
	challenge := b64.EncodeToString(sum[:])

	code := h.do("/api/auth/native/code", map[string]any{"codeChallenge": challenge}, signedIn).str("code")
	if code == "" {
		t.Fatal("no code")
	}
	if res := h.do("/api/auth/native/exchange", map[string]any{"code": code, "codeVerifier": "wrong"}, ""); res.status != http.StatusBadRequest {
		t.Fatalf("exchange with a wrong verifier: %d", res.status)
	}
	// The wrong guess burned the code.
	if res := h.do("/api/auth/native/exchange", map[string]any{"code": code, "codeVerifier": verifier}, ""); res.status != http.StatusBadRequest {
		t.Fatalf("a burned code was exchanged: %d", res.status)
	}

	code = h.do("/api/auth/native/code", map[string]any{"codeChallenge": challenge}, signedIn).str("code")
	res := h.do("/api/auth/native/exchange", map[string]any{"code": code, "codeVerifier": verifier}, "")
	if res.status != http.StatusOK || res.str("token") == "" {
		t.Fatalf("exchange: %d %v", res.status, res.body)
	}
}

func TestPasskeysShippedRules(t *testing.T) {
	app := rlstest.NewAssembledApp(t)
	for _, kind := range []string{"list", "view", "update", "delete"} {
		rlstest.RequireRuleContains(t, app, authfactor.PasskeysCollection, kind, "user = @request.auth.id")
	}
	for _, field := range []string{"user", "credential", "credential_id", "last_used"} {
		rlstest.RequireRuleContains(t, app, authfactor.PasskeysCollection, "update", "@request.body."+field+":isset = false")
	}
	if rule, ok := rlstest.Rule(t, app, authfactor.PasskeysCollection, "create"); ok {
		t.Fatalf("passkeys create rule must be locked (nil), got %q", rule)
	}
	col, err := app.FindCollectionByNameOrId(authfactor.PasskeysCollection)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"credential", "credential_id"} {
		if f := col.Fields.GetByName(name); f == nil || !f.GetHidden() {
			t.Errorf("passkeys.%s must be hidden", name)
		}
	}
}

func TestRemovingLastPasskeyRefusedWhenMFARequired(t *testing.T) {
	h := newHarness(t)
	ada := h.user("ada@test.local")
	token := h.session(ada)
	first := h.register(newSoftKey(t), token, nil).obj("record")["id"].(string)
	second := h.register(newSoftKey(t), token, nil).obj("record")["id"].(string)

	settings, err := h.app.FindCollectionByNameOrId("system_settings")
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(settings)
	row.Set("key", mfa.RequireMFAKey)
	row.Set("value", "true")
	if err := h.app.Save(row); err != nil {
		t.Fatal(err)
	}

	del := func(id string) int {
		req := httptest.NewRequest(http.MethodDelete, "https://"+testHost+"/api/collections/passkeys/records/"+id, nil)
		req.Header.Set("Authorization", token)
		rec := httptest.NewRecorder()
		h.mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := del(first); code != http.StatusNoContent {
		t.Fatalf("removing one of two passkeys: %d", code)
	}
	if code := del(second); code != http.StatusBadRequest {
		t.Fatalf("removing the last factor under required MFA: %d", code)
	}
	if !authfactor.HasSecondFactor(h.app, ada.Id) {
		t.Fatal("the last factor was removed")
	}
}
