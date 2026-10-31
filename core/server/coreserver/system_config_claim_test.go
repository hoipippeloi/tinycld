package coreserver

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/syscfg"
)

func newSystemConfigApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	createSystemSettingsCollection(t, app)
	return app
}

// Two apps in one process each read their own system_settings. The in-memory
// map was one process-wide instance, so a row one app saved answered every
// other app's reads.
func TestSystemConfigIsPerApp(t *testing.T) {
	a, b := newSystemConfigApp(t), newSystemConfigApp(t)
	RegisterSystemConfig(a)
	RegisterSystemConfig(b)

	saveSetting(t, a, "mail.from_address", "hello@a.test")

	if got := syscfg.Get(a, "mail.from_address"); got != "hello@a.test" {
		t.Fatalf("app A reads %q, want its own row", got)
	}
	if got := syscfg.Get(b, "mail.from_address"); got != "" {
		t.Fatalf("app B resolved app A's setting: %q", got)
	}
	if got := SystemSettings(b).Get("mail.from_address"); got != "" {
		t.Fatalf("app B's SystemConfig holds app A's row: %q", got)
	}
}

// A supervising composition's claim on one app leaves another app
// administering its own settings: the refusal consults the claim of the app
// the write belongs to.
func TestManagedClaimIsPerApp(t *testing.T) {
	a, b := newSystemConfigApp(t), newSystemConfigApp(t)
	syscfg.SetProvider(a, managedProvider{prefixes: []string{"mail."}})
	RegisterSystemConfig(a)
	RegisterSystemConfig(b)

	if !syscfg.IsClaimed(a) {
		t.Fatal("app A's composition claim was lost")
	}
	if syscfg.IsClaimed(b) {
		t.Fatal("app A's claim reached app B")
	}

	col, err := a.FindCollectionByNameOrId("system_settings")
	if err != nil {
		t.Fatal(err)
	}
	refused := core.NewRecord(col)
	refused.Set("key", "mail.provider")
	refused.Set("value", "smtp")
	if err := a.Save(refused); err == nil {
		t.Error("app A accepted a write to a key its composition manages")
	}

	saveSetting(t, b, "mail.provider", "smtp")
	if got := syscfg.Get(b, "mail.provider"); got != "smtp" {
		t.Fatalf("app B could not administer its own mail settings: %q", got)
	}
}

// The page shell carries the public config of the app that serves it, never
// another app's Sentry DSN or VAPID key.
func TestInjectPublicConfigIsPerApp(t *testing.T) {
	a, b := newSystemConfigApp(t), newSystemConfigApp(t)
	RegisterSystemConfig(a)
	RegisterSystemConfig(b)
	saveSetting(t, a, "sentry.dsn", "https://a@o1.ingest.sentry.io/1")

	if out := string(injectPublicConfig(a, []byte("<head></head>"))); !strings.Contains(out, "https://a@o1.ingest.sentry.io/1") {
		t.Fatalf("app A's shell lacks its own DSN: %q", out)
	}
	if out := string(injectPublicConfig(b, []byte("<head></head>"))); out != "<head></head>" {
		t.Fatalf("app B's shell carries app A's config: %q", out)
	}
}
