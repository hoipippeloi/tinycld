package nativeauth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"
)

func newNativeAuthApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func jsonEvent(app core.App, path string, body any) (*core.RequestEvent, *httptest.ResponseRecorder) {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	re := &core.RequestEvent{App: app}
	re.Request = req
	re.Response = rec
	return re, rec
}

func isBadRequest(err error) bool {
	var apiErr *router.ApiError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusBadRequest
}

// Both apps clone the same bundled data, so the user id exists in each: a
// code that one app issued must still not sign that id in on the other.
func TestCodeIssuedOnOneAppIsRefusedOnAnother(t *testing.T) {
	a, b := newNativeAuthApp(t), newNativeAuthApp(t)
	user, err := a.FindAuthRecordByEmail("users", "test@example.com")
	if err != nil {
		t.Fatal(err)
	}

	verifier := "a-verifier-long-enough-for-pkce-0123456789abcdef"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	reCode, recCode := jsonEvent(a, "/api/auth/native/code", map[string]any{"codeChallenge": challenge})
	reCode.Auth = user
	if err := handleCode(reCode); err != nil {
		t.Fatalf("handleCode: %v", err)
	}
	var issued struct{ Code string }
	if err := json.Unmarshal(recCode.Body.Bytes(), &issued); err != nil || issued.Code == "" {
		t.Fatalf("no code in %s", recCode.Body.String())
	}

	exchange := map[string]any{"code": issued.Code, "codeVerifier": verifier}
	reB, _ := jsonEvent(b, "/api/auth/native/exchange", exchange)
	if err := handleExchange(b, reB); !isBadRequest(err) {
		t.Fatalf("app B accepted app A's code: err = %v", err)
	}

	reA, _ := jsonEvent(a, "/api/auth/native/exchange", exchange)
	if err := handleExchange(a, reA); isBadRequest(err) {
		t.Fatalf("the issuing app refused its own code: %v", err)
	}
}

func TestTicketLedgerIsPerApp(t *testing.T) {
	a, b := newNativeAuthApp(t), newNativeAuthApp(t)
	if !ticketsFor(a).spend("jti-1") {
		t.Fatal("first spend on app A refused")
	}
	if !ticketsFor(b).spend("jti-1") {
		t.Fatal("app A's spent ticket id was recorded as spent on app B")
	}
}
