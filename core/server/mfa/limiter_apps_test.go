package mfa

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newLimiterApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func limiterEvent(app core.App) *core.RequestEvent {
	re := &core.RequestEvent{App: app}
	re.Request = httptest.NewRequest(http.MethodPost, "/api/auth/mfa/verify", nil)
	re.Response = httptest.NewRecorder()
	return re
}

// Both test apps clone the same bundled data, so the user has the same id in
// each: exactly the case where a process-wide budget keyed by user id lets
// guesses on one app lock the user out of another.
func TestCodeLimiterIsPerApp(t *testing.T) {
	a, b := newLimiterApp(t), newLimiterApp(t)
	user, err := a.FindAuthRecordByEmail("users", "test@example.com")
	if err != nil {
		t.Fatal(err)
	}

	reA := limiterEvent(a)
	for allowCode(reA, user) {
	}

	if !allowCode(limiterEvent(b), user) {
		t.Fatal("code guesses on app A used up the same user id's budget on app B")
	}
}
