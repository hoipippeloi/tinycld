package apis

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// The empty-search throttle (a random sleep of up to 500ms once a client has
// made more than three filtered list requests that returned nothing within
// three seconds) exists to blur timing differences for an attacker probing a
// collection's list rule. TinyCld's client loads every screen through filtered
// live queries, many of which are legitimately empty for a fresh user, so a
// signed-in user hit the sleep several times on every cold load. Signed-in
// members are not the audience the guard is for, so they skip it; guests keep
// upstream behavior.

// clients collection, test@example.com — matches demo3's list rule.
const clientsAuthToken = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImdrMzkwcWVnczR5NDd3biIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoidjg1MXE0cjc5MHJoa25sIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.0ONnm_BsvPRZyDNT31GN1CKUB6uQRxvVvQ-Wc9AZfG0"

func newThrottleTestApp(t *testing.T) core.App {
	t.Helper()
	_, currentFile, _, _ := runtime.Caller(0)
	src := filepath.Join(filepath.Dir(currentFile), "..", "tests", "data")
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(src)); err != nil {
		t.Fatalf("copy test data: %v", err)
	}
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: dir})
	if err := app.Bootstrap(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	t.Cleanup(func() { app.ResetBootstrapState() })
	app.Settings().Logs.MaxDays = 0
	return app
}

func newThrottleTestMux(t *testing.T, app core.App) http.Handler {
	t.Helper()
	pbRouter, err := NewRouter(app)
	if err != nil {
		t.Fatalf("router: %v", err)
	}
	mux, err := pbRouter.BuildMux()
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	return mux
}

// countListTimingThrottle swaps the sleep for a counter for the test's life.
func countListTimingThrottle(t *testing.T) *int {
	t.Helper()
	calls := 0
	original := listTimingThrottle
	listTimingThrottle = func(int64) { calls++ }
	t.Cleanup(func() { listTimingThrottle = original })
	return &calls
}

func emptyFilteredList(t *testing.T, mux http.Handler, collection, filter, token string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/collections/"+collection+"/records?filter="+url.QueryEscape(filter), nil)
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRecordsListTimingThrottleSkipsAuthenticated(t *testing.T) {
	calls := countListTimingThrottle(t)
	app := newThrottleTestApp(t)
	mux := newThrottleTestMux(t, app)

	for range 6 {
		emptyFilteredList(t, mux, "demo3", `title = "no such title"`, clientsAuthToken)
	}

	if *calls != 0 {
		t.Fatalf("expected no throttle for authenticated empty searches, got %d", *calls)
	}
}

func TestRecordsListTimingThrottleStillGuardsGuests(t *testing.T) {
	calls := countListTimingThrottle(t)
	app := newThrottleTestApp(t)
	mux := newThrottleTestMux(t, app)

	for range 6 {
		emptyFilteredList(t, mux, "demo5", `total = -1`, "")
	}

	// The rate limit rule allows three empty searches per three seconds; the
	// three after it are throttled.
	if *calls != 3 {
		t.Fatalf("expected 3 throttled guest searches, got %d", *calls)
	}
}
