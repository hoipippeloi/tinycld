package coreserver_test

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/coreserver"
	"tinycld.org/core/multiapptest"
)

// putSetting creates or updates app's system_settings row for key.
func putSetting(t *testing.T, app core.App, key, value string, secret bool) {
	t.Helper()
	row, err := app.FindFirstRecordByData("system_settings", "key", key)
	if err != nil {
		col, err := app.FindCollectionByNameOrId("system_settings")
		if err != nil {
			t.Fatal(err)
		}
		row = core.NewRecord(col)
		row.Set("key", key)
	}
	row.Set("value", value)
	row.Set("is_secret", secret)
	if err := app.Save(row); err != nil {
		t.Fatalf("save setting %q: %v", key, err)
	}
}

// Each app reads its own system_settings: a value saved in one app, and the
// change callbacks it fires, never reach another app in the process.
func TestSystemSettingsAreKeptPerApp(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	multiapptest.Serve(t, a)
	multiapptest.Serve(t, b)

	var changedOnA []string
	coreserver.SystemSettings(a).OnChange(func(key, _ string) {
		changedOnA = append(changedOnA, key)
	})

	putSetting(t, a, "vapid.subject", "mailto:a@example.com", false)
	putSetting(t, b, "vapid.subject", "mailto:b@example.com", false)
	putSetting(t, b, "backup.repository.kind", "s3", false)

	if got := coreserver.SystemSettings(a).Get("vapid.subject"); got != "mailto:a@example.com" {
		t.Errorf("app A reads vapid.subject = %q, want its own value", got)
	}
	if got := coreserver.SystemSettings(b).Get("vapid.subject"); got != "mailto:b@example.com" {
		t.Errorf("app B reads vapid.subject = %q, want its own value", got)
	}
	if got := coreserver.SystemSettings(a).Get("backup.repository.kind"); got != "" {
		t.Errorf("app A reads app B's backup.repository.kind = %q", got)
	}
	if strings.Join(changedOnA, ",") != "vapid.subject" {
		t.Errorf("app A's change callback saw %v, want only its own vapid.subject", changedOnA)
	}
}

// The is_secret gate on the page's injected config is the app's own: a row
// app A flags secret stays out of A's page whatever another app stores.
func TestPublicConfigHonoursEachAppsSecretFlag(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	multiapptest.Serve(t, a)
	multiapptest.Serve(t, b)

	putSetting(t, a, "sentry.dsn", "https://secret-a@example.test/1", true)
	putSetting(t, b, "sentry.dsn", "https://public-b@example.test/2", false)

	shell := []byte("<html><head></head><body></body></html>")
	if out := string(coreserver.InjectPublicConfigForTest(a, shell)); strings.Contains(out, "sentryDsn") {
		t.Errorf("app A's page publishes a DSN its own row flags secret: %s", out)
	}
	if out := string(coreserver.InjectPublicConfigForTest(b, shell)); !strings.Contains(out, "https://public-b@example.test/2") {
		t.Errorf("app B's page lacks its public DSN: %s", out)
	}
}
