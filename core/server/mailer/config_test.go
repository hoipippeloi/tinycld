package mailer

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/syscfg"
)

// withConfig returns an app whose syscfg seam reads values, and forces
// devAutoLog off so delivery decisions reflect config alone.
func withConfig(t *testing.T, values map[string]string) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	syscfg.SetResolver(app, func(key string) string { return values[key] })
	origDev := devAutoLog
	devAutoLog = false
	t.Cleanup(func() { devAutoLog = origDev })
	return app
}

func TestDefaultSender_LogsWhenUnconfigured(t *testing.T) {
	app := withConfig(t, map[string]string{})
	if _, ok := DefaultSender(app).(*LogSender); !ok {
		t.Errorf("expected LogSender when no provider configured, got %T", DefaultSender(app))
	}
	if CanDeliver(app) {
		t.Errorf("CanDeliver should be false when no provider configured")
	}
}

func TestDefaultSender_PostmarkWhenTokenSet(t *testing.T) {
	app := withConfig(t, map[string]string{
		keyPostmarkToken: "tok-123",
		keyFromAddress:   "hello@example.com",
	})
	s, ok := DefaultSender(app).(*PostmarkSender)
	if !ok {
		t.Fatalf("expected PostmarkSender, got %T", DefaultSender(app))
	}
	if s.defaultFrom != "hello@example.com" {
		t.Errorf("from: got %q, want hello@example.com", s.defaultFrom)
	}
	if !CanDeliver(app) {
		t.Errorf("CanDeliver should be true with a token set")
	}
}

func TestDefaultSender_SMTPWhenProviderSMTP(t *testing.T) {
	app := withConfig(t, map[string]string{
		keyProvider:       "smtp",
		keySMTPPublicHost: "mx.example.com",
	})
	if _, ok := DefaultSender(app).(*SMTPSender); !ok {
		t.Errorf("expected SMTPSender when provider=smtp, got %T", DefaultSender(app))
	}
	if !CanDeliver(app) {
		t.Errorf("CanDeliver should be true for smtp provider")
	}
}

func TestDefaultSender_DeliveryDisabledLogs(t *testing.T) {
	app := withConfig(t, map[string]string{
		keyPostmarkToken:   "tok-123",
		keyDeliveryEnabled: "false",
	})
	if _, ok := DefaultSender(app).(*LogSender); !ok {
		t.Errorf("expected LogSender when delivery disabled, got %T", DefaultSender(app))
	}
	if CanDeliver(app) {
		t.Errorf("CanDeliver should be false when delivery disabled")
	}
}

func TestDefaultSender_DevAutoLog(t *testing.T) {
	app := withConfig(t, map[string]string{keyPostmarkToken: "tok-123"})
	devAutoLog = true // simulate a --dev process
	if _, ok := DefaultSender(app).(*LogSender); !ok {
		t.Errorf("expected LogSender in --dev process, got %T", DefaultSender(app))
	}
}

func TestFromAddress_DefaultsWhenUnset(t *testing.T) {
	app := withConfig(t, map[string]string{})
	if got := fromAddress(app); got != defaultFromAddress {
		t.Errorf("fromAddress: got %q, want %q", got, defaultFromAddress)
	}
}
