package syscfg

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// fakeProvider is a supervisor-supplied provider: values from memory, plus the
// namespaces it owns.
type fakeProvider struct {
	values   map[string]string
	prefixes []string
}

func (f fakeProvider) Get(key string) string     { return f.values[key] }
func (f fakeProvider) ManagedPrefixes() []string { return f.prefixes }

// newApp returns an app with its own seam. Nothing is reset between tests:
// each test builds its own apps.
func newApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// Two apps in one process each resolve through their own provider. Before the
// seam moved onto the app, the last SetProvider in the process answered every
// app's reads: one app's mail credentials reached another app's sends.
func TestSeamIsPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetProvider(a, fakeProvider{
		values:   map[string]string{"mail.provider": "postmark"},
		prefixes: []string{"mail."},
	})
	SetResolver(b, func(key string) string {
		return map[string]string{"mail.provider": "smtp"}[key]
	})

	if got := Get(a, "mail.provider"); got != "postmark" {
		t.Fatalf("Get(a) = %q, want a's provider's value", got)
	}
	if got := Get(b, "mail.provider"); got != "smtp" {
		t.Fatalf("Get(b) = %q, want b's own value; a's provider answered b", got)
	}
	if !IsClaimed(a) {
		t.Error("SetProvider did not claim a's seam")
	}
	if IsClaimed(b) {
		t.Error("a's claim leaked into b; b could no longer administer its own settings")
	}
	if !IsManaged(a, "mail.provider") {
		t.Error("a's managed namespace is not managed on a")
	}
	if IsManaged(b, "mail.provider") {
		t.Error("a's managed namespace was reported managed on b")
	}
}

// A claim on one app must not make SetResolver inert on another. Core's own
// wiring for every app calls SetResolver; only the app whose composition
// claimed its seam may ignore it.
func TestClaimOnOneAppLeavesAnotherResolvable(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetProvider(a, emptySupervisor{})

	SetResolver(a, func(string) string { return "a's own" })
	SetResolver(b, func(string) string { return "b's own" })

	if got := Get(a, "mail.provider"); got != "" {
		t.Fatalf("Get(a) = %q; the claimed app reclaimed its own settings", got)
	}
	if got := Get(b, "mail.provider"); got != "b's own" {
		t.Fatalf("Get(b) = %q, want b's own resolver", got)
	}
}

func TestDefaultProviderManagesNothing(t *testing.T) {
	app := newApp(t)

	if got := Get(app, "sentry.dsn"); got != "" {
		t.Fatalf("Get on the zero provider = %q, want empty", got)
	}
	if prefixes := ManagedPrefixes(app); len(prefixes) != 0 {
		t.Fatalf("ManagedPrefixes = %v, want none", prefixes)
	}
	// The standalone guarantee: with nothing managed, every key stays editable.
	for _, key := range []string{"sentry.dsn", "vapid.private_key", "mail.provider"} {
		if IsManaged(app, key) {
			t.Errorf("IsManaged(%q) = true on a standalone deployment, want false", key)
		}
	}
}

func TestSetResolverSuppliesValuesButManagesNothing(t *testing.T) {
	app := newApp(t)
	SetResolver(app, func(key string) string {
		return map[string]string{"sentry.dsn": "https://example.invalid/1"}[key]
	})

	if got := Get(app, "sentry.dsn"); got != "https://example.invalid/1" {
		t.Fatalf("Get = %q, want the resolver's value", got)
	}
	// A standalone deployment reads its own settings AND administers them.
	if IsManaged(app, "sentry.dsn") {
		t.Error("IsManaged = true for a plain resolver; standalone manages nothing")
	}
}

// SetResolver stays last-wins on an unclaimed app: the backup schedule test
// and core's wiring both replace the resolver more than once.
func TestSetResolverReplacesOnAnUnclaimedApp(t *testing.T) {
	app := newApp(t)
	SetResolver(app, func(string) string { return "first" })
	SetResolver(app, func(string) string { return "second" })

	if got := Get(app, "k"); got != "second" {
		t.Fatalf("Get = %q, want the last resolver's value", got)
	}
}

func TestProviderSuppliesValuesAndManagedNamespaces(t *testing.T) {
	app := newApp(t)
	SetProvider(app, fakeProvider{
		values:   map[string]string{"mail.provider": "postmark", "vapid.private_key": "secret"},
		prefixes: []string{"sentry.", "vapid.", "mail."},
	})

	if got := Get(app, "mail.provider"); got != "postmark" {
		t.Fatalf("Get(mail.provider) = %q, want postmark", got)
	}

	for _, key := range []string{"mail.provider", "mail.smtp_imap_password", "sentry.dsn", "vapid.private_key"} {
		if !IsManaged(app, key) {
			t.Errorf("IsManaged(%q) = false, want true", key)
		}
	}
	// A key outside every managed namespace stays the deployment's own.
	for _, key := range []string{"storage_limit_bytes", "mailbox.other", "sentryish"} {
		if IsManaged(app, key) {
			t.Errorf("IsManaged(%q) = true, want false", key)
		}
	}
}

// A nil provider must not blank the resolver: that would silently disable mail,
// push and error reporting rather than surfacing the caller's bug.
func TestSetProviderIgnoresNil(t *testing.T) {
	app := newApp(t)
	SetProvider(app, fakeProvider{values: map[string]string{"mail.provider": "smtp"}})
	SetProvider(app, nil)

	if got := Get(app, "mail.provider"); got != "smtp" {
		t.Fatalf("Get after SetProvider(nil) = %q, want the previous provider's value", got)
	}
}

func TestSetResolverIgnoresNil(t *testing.T) {
	app := newApp(t)
	SetResolver(app, func(string) string { return "kept" })
	SetResolver(app, nil)

	if got := Get(app, "anything"); got != "kept" {
		t.Fatalf("Get after SetResolver(nil) = %q, want the previous resolver's value", got)
	}
}

// An empty prefix would match every key and lock a deployment out of its own
// settings. It must be ignored rather than treated as "everything".
func TestEmptyPrefixDoesNotManageEverything(t *testing.T) {
	app := newApp(t)
	SetProvider(app, fakeProvider{prefixes: []string{"", "mail."}})

	if IsManaged(app, "sentry.dsn") {
		t.Error("an empty prefix matched an unrelated key")
	}
	if !IsManaged(app, "mail.provider") {
		t.Error("a real prefix alongside an empty one stopped matching")
	}
}

// emptySupervisor is a supervising composition whose config failed to load: it
// installed a provider, but has no values and manages nothing YET.
type emptySupervisor struct{}

func (emptySupervisor) Get(string) string         { return "" }
func (emptySupervisor) ManagedPrefixes() []string { return nil }

// The claim must not be inferred from "does it manage anything". A supervisor
// whose syscfg.json was truncated or unreadable still OWNS these settings, and
// the correct degraded state is "mail, push and error reporting are off" — never
// "the deployment supplies its own".
func TestSupervisorWithNoPrefixesStillOwnsTheSeam(t *testing.T) {
	app := newApp(t)
	SetProvider(app, emptySupervisor{})

	if !IsClaimed(app) {
		t.Fatal("a supervisor's provider did not claim the seam")
	}

	// What coreserver.RegisterSystemConfig does moments later.
	SetResolver(app, func(string) string { return "the deployment's own value" })

	if got := Get(app, "mail.provider"); got != "" {
		t.Fatalf("core reclaimed the seam: Get returned %q — the deployment is now "+
			"supplying settings its operator owns", got)
	}
	if IsManaged(app, "mail.provider") {
		t.Error("nothing is managed yet, so IsManaged should be false; only the CLAIM persists")
	}
}

// An unclaimed deployment must still be able to point the seam at its own
// settings — the standalone path, which is every self-hosted install.
func TestUnclaimedSeamAcceptsTheDeploymentsOwnResolver(t *testing.T) {
	app := newApp(t)
	SetResolver(app, func(key string) string {
		return map[string]string{"mail.provider": "smtp"}[key]
	})
	if got := Get(app, "mail.provider"); got != "smtp" {
		t.Fatalf("a standalone deployment could not supply its own settings: %q", got)
	}
}
