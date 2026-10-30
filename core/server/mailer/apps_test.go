package mailer

import (
	"context"
	"testing"

	"tinycld.org/core/maildomains"
	"tinycld.org/core/syscfg"
)

// Each app sends through its own provider settings. ConfigResolver was one
// process-wide function, so the last app to register decided every app's
// provider and credentials.
func TestDefaultSenderReadsTheSendingAppsSettings(t *testing.T) {
	a := withConfig(t, map[string]string{keyPostmarkToken: "tok-a", keyFromAddress: "a@a.test"})
	b := withConfig(t, map[string]string{keyProvider: "smtp", keySMTPPublicHost: "mx.b.test"})

	s, ok := DefaultSender(a).(*PostmarkSender)
	if !ok {
		t.Fatalf("DefaultSender(a) = %T, want *PostmarkSender", DefaultSender(a))
	}
	if s.defaultFrom != "a@a.test" {
		t.Errorf("app A sends from %q, want its own from address", s.defaultFrom)
	}
	if _, ok := DefaultSender(b).(*SMTPSender); !ok {
		t.Fatalf("DefaultSender(b) = %T, want *SMTPSender", DefaultSender(b))
	}
}

// A derived server token installed for app A must not make app B deliver.
func TestServerTokenIsReadFromTheSendingApp(t *testing.T) {
	a := withConfig(t, map[string]string{})
	b := withConfig(t, map[string]string{})
	maildomains.SetServerTokenSource(a, func(context.Context) (string, error) { return "derived-a", nil })

	if _, ok := DefaultSender(a).(*PostmarkSender); !ok {
		t.Fatalf("DefaultSender(a) = %T, want *PostmarkSender from the derived token", DefaultSender(a))
	}
	if _, ok := DefaultSender(b).(*LogSender); !ok {
		t.Fatalf("DefaultSender(b) = %T; app B delivered with app A's token", DefaultSender(b))
	}
	if got := syscfg.Get(b, keyPostmarkToken); got != "" {
		t.Fatalf("app B's settings hold %q", got)
	}
}
