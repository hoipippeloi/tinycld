package automation

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
)

func newLedgerApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// A rule id is unique only in its app. Two apps in one process must not
// share a send ceiling, a failure streak, or write provenance.
func TestRunStateIsPerApp(t *testing.T) {
	a, b := newLedgerApp(t), newLedgerApp(t)
	now := time.Now()

	for i := 0; i < maxEmailsPerRulePerHour; i++ {
		if err := reserveEmailSend(a, "rule-1", now); err != nil {
			t.Fatalf("app A send %d refused: %v", i+1, err)
		}
	}
	if err := reserveEmailSend(a, "rule-1", now); err == nil {
		t.Fatal("app A's ceiling was not enforced")
	}
	if err := reserveEmailSend(b, "rule-1", now); err != nil {
		t.Fatalf("app B was charged for app A's sends: %v", err)
	}

	for i := 0; i < maxWebhookPostsPerRulePerHour; i++ {
		_ = reserveWebhookPost(a, "rule-1", now)
	}
	if err := reserveWebhookPost(b, "rule-1", now); err != nil {
		t.Fatalf("app B was charged for app A's webhook posts: %v", err)
	}

	markEngineWrite(a, "rec-1", "rule-1", 2)
	if _, ok := takeEngineWrite(b, "rec-1"); ok {
		t.Fatal("app B consumed app A's write provenance")
	}
	if w, ok := takeEngineWrite(a, "rec-1"); !ok || w.Depth != 2 {
		t.Fatalf("app A lost its own provenance: %+v %v", w, ok)
	}
}
