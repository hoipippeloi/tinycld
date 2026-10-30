package coreserver

import (
	"context"
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/maildomains"
	"tinycld.org/core/syscfg"
)

// Standalone: the deployment's own account token wires the direct registrar.
func TestMailDomainsWiredFromSettings(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	syscfg.SetResolver(app, func(key string) string {
		if key == "mail.postmark_account_token" {
			return "acct-token"
		}
		return ""
	})
	wireMailDomains(app)

	if _, ok := maildomains.Current(app).(*maildomains.PostmarkRegistrar); !ok {
		t.Fatalf("Current() = %T, want *maildomains.PostmarkRegistrar", maildomains.Current(app))
	}
}

// TestMailDomainsResolveTokenAfterLateLoad reproduces the REAL production
// boot order, not the inverted one the other tests here use for convenience.
//
// In production (system_config.go RegisterSystemConfig), wireMailDomains(app)
// runs synchronously and FIRST — before SystemSettings(app).load(app), which only
// happens later inside an OnServe hook. So at wiring time syscfg.Get returns
// "" for every key, including the account token. A registrar that captures
// the token at construction (the old behaviour) is permanently starved: it
// is stuck holding "" for the life of the process, so add-domain 503s
// forever on a plain standalone Postmark deployment, even after the
// system_settings row loads and even across restarts. This is C1 from the
// final whole-branch review.
//
// This test wires FIRST while the resolver has nothing, THEN populates it
// (simulating the later OnServe load), THEN asserts a call succeeds — the
// opposite order from TestMailDomainsWiredFromSettings above, which sets the
// resolver before wiring and so cannot catch a captured-at-construction bug.
func TestMailDomainsResolveTokenAfterLateLoad(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	token := ""
	syscfg.SetResolver(app, func(key string) string {
		if key == "mail.postmark_account_token" {
			return token
		}
		return ""
	})

	// Wire while the token does not exist yet — the real boot order.
	wireMailDomains(app)

	reg, ok := maildomains.Current(app).(*maildomains.PostmarkRegistrar)
	if !ok {
		t.Fatalf("Current() = %T, want *maildomains.PostmarkRegistrar", maildomains.Current(app))
	}

	// AddDomain must fail before the settings row has loaded.
	if _, err := reg.AddDomain(context.Background(), "acme.com"); !errors.Is(err, maildomains.ErrNotConfigured) {
		t.Fatalf("AddDomain before load: err = %v, want ErrNotConfigured", err)
	}

	// Simulate the later OnServe load populating the value.
	token = "acct-token"

	// The SAME registrar instance (no re-wiring) must now resolve the token
	// and get PAST the ErrNotConfigured gate. wireMailDomains builds a real
	// postmark.Client, so we cannot let this reach the network in a unit
	// test; an already-expired context makes the underlying HTTP call fail
	// immediately with a deadline error instead. Any error OTHER than
	// ErrNotConfigured proves the token resolved — that is the only thing
	// this regression is about.
	expiredCtx, cancel := context.WithTimeout(context.Background(), 0)
	defer cancel()
	<-expiredCtx.Done()
	if _, err := reg.AddDomain(expiredCtx, "acme.com"); errors.Is(err, maildomains.ErrNotConfigured) {
		t.Fatalf("AddDomain after load: err = %v, want the token to resolve (not ErrNotConfigured)", err)
	}
}

// A supervising composition already claimed the seam: core must not reclaim
// it. This is the security property, tested at the wiring level rather than
// trusting the seam alone.
func TestMailDomainsWiringRespectsClaim(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	claimed := stubClaimedRegistrar{}
	maildomains.SetRegistrar(app, claimed)

	syscfg.SetResolver(app, func(string) string { return "acct-token" })
	wireMailDomains(app)

	if _, ok := maildomains.Current(app).(stubClaimedRegistrar); !ok {
		t.Fatalf("Current() = %T, want the supervisor's registrar to survive core wiring", maildomains.Current(app))
	}
}

type stubClaimedRegistrar struct{}

func (stubClaimedRegistrar) AddDomain(context.Context, string) (*maildomains.DomainRecords, error) {
	return nil, nil
}
func (stubClaimedRegistrar) GetDomain(context.Context, string, int64) (*maildomains.DomainRecords, error) {
	return nil, nil
}

// The sender-facing token source answers from the configured server token
// without touching Postmark, and reports not configured when neither token
// is set. Derivation itself is covered in package maildomains.
func TestServerTokenSourceUsesConfiguredToken(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	values := map[string]string{}
	syscfg.SetResolver(app, func(key string) string { return values[key] })
	wireMailDomains(app)

	if _, err := maildomains.ServerToken(context.Background(), app); !errors.Is(err, maildomains.ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured with no tokens", err)
	}
	values["mail.postmark_server_token"] = "srv-token"
	got, err := maildomains.ServerToken(context.Background(), app)
	if err != nil || got != "srv-token" {
		t.Fatalf("got %q, %v; want the configured server token", got, err)
	}
}

// A composition that claimed the seam keeps the account token away from the
// org and ships it a server token instead. Senders must still get that token.
func TestServerTokenSourceInstalledWhenClaimed(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	maildomains.SetRegistrar(app, &maildomains.PostmarkRegistrar{})
	syscfg.SetResolver(app, func(key string) string {
		if key == "mail.postmark_server_token" {
			return "shipped-token"
		}
		return ""
	})
	wireMailDomains(app)

	got, err := maildomains.ServerToken(context.Background(), app)
	if err != nil || got != "shipped-token" {
		t.Fatalf("got %q, %v; want the shipped server token", got, err)
	}
}

// Core's wiring installs a token source per app: each app's senders get the
// server token its own settings name.
func TestMailWiringIsPerApp(t *testing.T) {
	a, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Cleanup)
	b, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Cleanup)
	syscfg.SetResolver(a, func(key string) string {
		return map[string]string{"mail.postmark_server_token": "srv-a"}[key]
	})
	syscfg.SetResolver(b, func(key string) string {
		return map[string]string{"mail.postmark_server_token": "srv-b"}[key]
	})
	wireMailDomains(a)
	wireMailDomains(b)

	if got, err := maildomains.ServerToken(context.Background(), a); err != nil || got != "srv-a" {
		t.Fatalf("app A token = %q, %v; want srv-a", got, err)
	}
	if got, err := maildomains.ServerToken(context.Background(), b); err != nil || got != "srv-b" {
		t.Fatalf("app B token = %q, %v; want srv-b", got, err)
	}
}
