package multiapptest_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tinycld.org/core/multiapptest"
	"tinycld.org/core/readonly"
)

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTwoFullCompositionsBootInOneProcess(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	for i, app := range apps {
		if _, err := app.FindCollectionByNameOrId("users"); err != nil {
			t.Fatalf("app %d: users collection missing: %v", i, err)
		}
		if rec := do(t, multiapptest.Serve(t, app), http.MethodGet, "/api/health", ""); rec.Code != http.StatusOK {
			t.Fatalf("app %d: /api/health = %d", i, rec.Code)
		}
	}
}

func TestReadOnlyOnOneAppLeavesTheOtherWritable(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	ha, hb := multiapptest.Serve(t, a), multiapptest.Serve(t, b)

	readonly.Enter(a)

	recA := do(t, ha, http.MethodPost, "/api/collections/users/records", `{}`)
	if recA.Code != http.StatusServiceUnavailable || !strings.Contains(recA.Body.String(), readonly.Code) {
		t.Fatalf("app A write: got %d %s, want 503 with %q", recA.Code, recA.Body.String(), readonly.Code)
	}
	recB := do(t, hb, http.MethodPost, "/api/collections/users/records", `{}`)
	if recB.Code == http.StatusServiceUnavailable {
		t.Fatalf("app B write was refused as read-only: %s", recB.Body.String())
	}
	if readonly.Active(b) {
		t.Fatal("app B reports read-only mode")
	}
}

func TestTerminatingOneAppLeavesTheOtherServing(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	hb := multiapptest.Serve(t, b)

	multiapptest.Terminate(t, a)

	if rec := do(t, hb, http.MethodGet, "/api/health", ""); rec.Code != http.StatusOK {
		t.Fatalf("app B after app A terminated: /api/health = %d", rec.Code)
	}
	if _, err := b.FindCollectionByNameOrId("users"); err != nil {
		t.Fatalf("app B DB unusable after app A terminated: %v", err)
	}
}

// An embedder closes an idle app and opens it again later on the same data
// dir. appstate.ID is derived from the data dir, so the reopened app has the
// same ID as the closed one: process registries keyed by it must have
// dropped the old entry at terminate, and nothing may panic as a duplicate.
func TestReopenOnTheSameDataDirAfterTerminate(t *testing.T) {
	first := multiapptest.NewApps(t, 1)[0]
	dir := first.DataDir()
	readonly.Enter(first)
	multiapptest.Terminate(t, first)

	again := multiapptest.NewAppsWith(t, 1, multiapptest.Options{DataDir: dir})[0]

	if readonly.Active(again) {
		t.Fatal("the reopened app inherited the closed app's read-only mode")
	}
	h := multiapptest.Serve(t, again)
	if rec := do(t, h, http.MethodGet, "/api/health", ""); rec.Code != http.StatusOK {
		t.Fatalf("reopened app: /api/health = %d", rec.Code)
	}
	readonly.Enter(again)
	if rec := do(t, h, http.MethodPost, "/api/collections/users/records", `{}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("reopened app ignores its own read-only mode: got %d", rec.Code)
	}
}

// An embedder opens apps on demand, so two first requests can boot two apps
// at the same time. Every Register path must be race-free; run with -race.
func TestAppsBootConcurrently(t *testing.T) {
	for i := range 4 {
		t.Run(fmt.Sprintf("app%d", i), func(t *testing.T) {
			t.Parallel()
			app := multiapptest.NewApps(t, 1)[0]
			if rec := do(t, multiapptest.Serve(t, app), http.MethodGet, "/api/health", ""); rec.Code != http.StatusOK {
				t.Fatalf("/api/health = %d", rec.Code)
			}
		})
	}
}
