package multiapptest_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
	"tinycld.org/core/multiapptest"
)

func TestNewAppsBootsSeparateMigratedApps(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	if len(apps) != 2 {
		t.Fatalf("got %d apps, want 2", len(apps))
	}
	a, b := apps[0], apps[1]

	if a.DataDir() == b.DataDir() {
		t.Fatalf("both apps use data dir %s", a.DataDir())
	}
	if appstate.ID(a) == appstate.ID(b) {
		t.Fatalf("both apps have id %s", appstate.ID(a))
	}
	for i, app := range apps {
		if !app.IsBootstrapped() {
			t.Fatalf("app %d is not bootstrapped", i)
		}
		for _, name := range []string{"users", "system_settings", "pkg_registry"} {
			if _, err := app.FindCollectionByNameOrId(name); err != nil {
				t.Fatalf("app %d has no %s collection: %v", i, name, err)
			}
		}
	}

	// Separate databases: a row saved in one app is absent from the other.
	settings, err := a.FindCollectionByNameOrId("system_settings")
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(settings)
	row.Set("key", "multiapptest.marker")
	row.Set("value", "a")
	if err := a.Save(row); err != nil {
		t.Fatal(err)
	}
	if _, err := b.FindFirstRecordByData("system_settings", "key", "multiapptest.marker"); err == nil {
		t.Fatal("a row saved in app A is visible in app B")
	}
}

func TestServeAnswersEachAppsRoutes(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	for i, app := range apps {
		h := multiapptest.Serve(t, app)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("app %d: GET /api/health = %d %s", i, rec.Code, rec.Body.String())
		}
	}
}

func TestTerminateStopsOnlyThatApp(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	multiapptest.Terminate(t, apps[0])
	if apps[0].IsBootstrapped() {
		t.Fatal("app A is still bootstrapped after Terminate")
	}
	if !apps[1].IsBootstrapped() {
		t.Fatal("terminating app A stopped app B")
	}
	if _, err := apps[1].FindCollectionByNameOrId("users"); err != nil {
		t.Fatalf("app B cannot read its database after A terminated: %v", err)
	}
}
