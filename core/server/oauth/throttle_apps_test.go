package oauth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func TestTokenThrottleIsPerApp(t *testing.T) {
	installTestTokenThrottle(t)
	newApp := func() *tests.TestApp {
		app, err := tests.NewTestApp()
		if err != nil {
			t.Fatalf("NewTestApp: %v", err)
		}
		t.Cleanup(app.Cleanup)
		return app
	}
	a, b := newApp(), newApp()
	const grant = "urn:ietf:params:oauth:grant-type:device_code"
	req := func() *http.Request { return httptest.NewRequest(http.MethodPost, "/oauth/token", nil) }

	for i := 0; i < tokenMaxFailures; i++ {
		noteTokenFailure(a, req(), grant)
	}
	if !tooManyTokenFailures(a, req(), grant) {
		t.Fatal("app A is not throttled after tokenMaxFailures")
	}
	if tooManyTokenFailures(b, req(), grant) {
		t.Fatal("app B was throttled by app A's failed exchanges")
	}
}
