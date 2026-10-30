package automation

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/mailer"
	"tinycld.org/core/rlstest"
)

// send_guard_test.go covers the skip result and the send-guard registry with
// a fictional package, "zoo", whose zoo_messages rows can be automatic.

type zooEnv struct {
	app  core.App
	user *core.Record
	sent *[]*mailer.Message
}

func zooEngineApp(t *testing.T) *zooEnv {
	t.Helper()
	t.Cleanup(ResetRegistriesForTest)
	app := rlstest.NewMigratedApp(t, rlstest.MigrationsDir(t, "../pb_migrations"))
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	col := core.NewBaseCollection("zoo_messages")
	col.Fields.Add(&core.TextField{Name: "subject"})
	col.Fields.Add(&core.BoolField{Name: "is_automatic"})
	col.Fields.Add(&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1})
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}

	defs := &Defs{Packages: []PackageDefs{
		{Slug: "core", Actions: []ActionDef{{
			ID: "send-email", Label: "Send an email", Kind: "native",
			Params: []ParamDef{
				{Key: "to", Type: "text"}, {Key: "subject", Type: "text"}, {Key: "body", Type: "text"},
			},
		}}},
		{
			Slug:     "zoo",
			Triggers: []TriggerDef{{ID: "message-arrived", Label: "arrived", Collection: "zoo_messages", On: "create"}},
			Actions:  []ActionDef{{ID: "skipper", Label: "skipper", Kind: "native"}},
		},
	}}
	registerCoreNativeActions()
	NewEngine(app, defs).Start()

	u, err := app.FindFirstRecordByFilter("users", "id != ''")
	if err != nil {
		t.Fatal(err)
	}
	return &zooEnv{app: app, user: u, sent: captureEmails(t)}
}

func (z *zooEnv) rule(t *testing.T, actions ...map[string]any) *core.Record {
	t.Helper()
	col, _ := z.app.FindCollectionByNameOrId("rules")
	r := core.NewRecord(col)
	r.Set("name", "zoo rule")
	r.Set("scope", "org")
	r.Set("owner", z.user.Id)
	r.Set("trigger", "zoo:message-arrived")
	r.Set("actions", actions)
	r.Set("enabled", true)
	if err := z.app.Save(r); err != nil {
		t.Fatal(err)
	}
	return r
}

func (z *zooEnv) arrive(t *testing.T, subject string, automatic bool) {
	t.Helper()
	col, _ := z.app.FindCollectionByNameOrId("zoo_messages")
	rec := core.NewRecord(col)
	rec.Set("subject", subject)
	rec.Set("is_automatic", automatic)
	rec.Set("user", z.user.Id)
	if err := z.app.Save(rec); err != nil {
		t.Fatal(err)
	}
}

func runResults(t *testing.T, run *core.Record) []ActionResult {
	t.Helper()
	var results []ActionResult
	if err := json.Unmarshal([]byte(run.GetString("results")), &results); err != nil {
		t.Fatalf("decode results: %v", err)
	}
	return results
}

var sendEmailAction = map[string]any{
	"ref":    "core:send-email",
	"params": map[string]any{"to": "keeper@zoo.example", "subject": "Re: {{subject}}", "body": "Got it"},
}

func TestSendGuard_SkipsCoreSendEmail(t *testing.T) {
	z := zooEngineApp(t)
	RegisterSendGuard("zoo_messages", "zoo.automatic", func(_ core.App, record *core.Record) (bool, string) {
		return record.GetBool("is_automatic"), "The zoo message was automatic."
	})
	rule := z.rule(t, sendEmailAction)

	z.arrive(t, "Out of office", true)

	runs := waitForRuns(t, z.app, rule.Id, 1)
	results := runResults(t, runs[0])
	want := ActionResult{Ref: "core:send-email", Status: "skipped", Message: "The zoo message was automatic."}
	if len(results) != 1 || results[0] != want {
		t.Fatalf("results = %+v, want [%+v]", results, want)
	}
	if len(*z.sent) != 0 {
		t.Fatalf("sent %d emails, want 0: the guard said skip", len(*z.sent))
	}

	// The guard answers per record: a message it lets through still sends.
	z.arrive(t, "Hello", false)
	runs = waitForRuns(t, z.app, rule.Id, 2)
	if got := runResults(t, runs[0]); len(got) != 1 || got[0].Status != "ok" {
		t.Fatalf("results for a normal message = %+v, want one ok", got)
	}
	if len(*z.sent) != 1 {
		t.Fatalf("sent %d emails, want 1", len(*z.sent))
	}
}

// A guard registered for another collection does not apply.
func TestSendGuard_OnlyItsCollection(t *testing.T) {
	z := zooEngineApp(t)
	RegisterSendGuard("zoo_keepers", "zoo.keepers", func(core.App, *core.Record) (bool, string) {
		return true, "not for zoo_messages"
	})
	rule := z.rule(t, sendEmailAction)

	z.arrive(t, "Out of office", true)

	runs := waitForRuns(t, z.app, rule.Id, 1)
	if got := runResults(t, runs[0]); len(got) != 1 || got[0].Status != "ok" {
		t.Fatalf("results = %+v, want one ok", got)
	}
	if len(*z.sent) != 1 {
		t.Fatalf("sent %d emails, want 1", len(*z.sent))
	}
}

func TestCoreSendEmail_MarksMailAsAutomatic(t *testing.T) {
	z := zooEngineApp(t)
	z.app.Settings().Meta.AppURL = "https://zoo.example:8443/app"
	rule := z.rule(t, sendEmailAction)

	z.arrive(t, "Hello", false)

	waitForRuns(t, z.app, rule.Id, 1)
	if len(*z.sent) != 1 {
		t.Fatalf("sent %d emails, want 1", len(*z.sent))
	}
	want := map[string]string{"Auto-Submitted": "auto-generated", "X-TinyCld-Loop": "zoo.example"}
	if got := (*z.sent)[0].Headers; !equalHeaders(got, want) {
		t.Fatalf("Headers = %v, want %v", got, want)
	}
}

func TestCoreSendEmail_LoopHostDefaultsToTinycld(t *testing.T) {
	app, rule := runsApp(t)
	sent := captureEmails(t)
	app.Settings().Meta.AppURL = ""

	if err := actionSendEmail(app, ActionRequest{
		Rule:   rule,
		Params: map[string]string{"to": "a@example.com", "subject": "s", "body": "b"},
	}); err != nil {
		t.Fatalf("actionSendEmail: %v", err)
	}
	if got := (*sent)[0].Headers["X-TinyCld-Loop"]; got != "tinycld" {
		t.Fatalf("X-TinyCld-Loop = %q, want tinycld", got)
	}
}

// A skip must not use up the rule's hourly send budget.
func TestSendGuard_SkipDoesNotConsumeTheSendBudget(t *testing.T) {
	app, rule := runsApp(t)
	t.Cleanup(ResetRegistriesForTest)
	captureEmails(t)
	RegisterSendGuard("rules", "test.always", func(core.App, *core.Record) (bool, string) { return true, "always" })

	req := ActionRequest{
		Rule: rule, Record: rule,
		Params: map[string]string{"to": "a@example.com", "subject": "s", "body": "b"},
	}
	for i := 0; i <= maxEmailsPerRulePerHour; i++ {
		if err := actionSendEmail(app, req); !IsSkip(err) {
			t.Fatalf("send %d = %v, want a skip", i, err)
		}
	}
	if err := reserveEmailSend(app, rule.Id, time.Now()); err != nil {
		t.Fatalf("skips used the send budget: %v", err)
	}
}

func TestSkip_FromAnyActionIsRecordedAsSkipped(t *testing.T) {
	z := zooEngineApp(t)
	RegisterAction("zoo:skipper", func(core.App, ActionRequest) error {
		return fmt.Errorf("zoo:skipper: %w", Skip("Nothing to feed."))
	})
	rule := z.rule(t, map[string]any{"ref": "zoo:skipper"})
	// One more fully failed run would disable the rule. A skip is not a
	// failure, so the rule stays enabled and the streak ends.
	runStateFor(z.app).failureStreaks.Store(rule.Id, autoDisableAfter-1)
	// Checked as the run row is written, not after: a reader that finds the
	// row must already see the streak's end, with no window between them.
	streakAtWrite := make(chan bool, 1)
	z.app.OnRecordAfterCreateSuccess("rule_runs").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("rule") == rule.Id {
			_, kept := runStateFor(z.app).failureStreaks.Load(rule.Id)
			streakAtWrite <- kept
		}
		return e.Next()
	})

	z.arrive(t, "Hello", false)

	runs := waitForRuns(t, z.app, rule.Id, 1)
	want := ActionResult{Ref: "zoo:skipper", Status: "skipped", Message: "Nothing to feed."}
	if got := runResults(t, runs[0]); len(got) != 1 || got[0] != want {
		t.Fatalf("results = %+v, want [%+v]", got, want)
	}
	if runs[0].GetString("error") != "" {
		t.Fatalf("run error = %q, want none", runs[0].GetString("error"))
	}
	if <-streakAtWrite {
		t.Fatal("a skipped run kept the failure streak")
	}
	fresh, _ := z.app.FindRecordById("rules", rule.Id)
	if !fresh.GetBool("enabled") {
		t.Fatal("a skipped run disabled the rule")
	}
}

func TestSkip_ReasonIsTheMessage(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", Skip("Already done."))
	if !IsSkip(err) {
		t.Fatal("IsSkip(wrapped skip) = false")
	}
	if IsSkip(fmt.Errorf("boom")) || IsSkip(nil) {
		t.Fatal("IsSkip is true for an error that is not a skip")
	}
	if got := Skip("Already done.").Error(); got != "skipped: Already done." {
		t.Fatalf("Error() = %q", got)
	}
}

func equalHeaders(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

func TestRuleMailHeaders(t *testing.T) {
	app, _ := runsApp(t)
	app.Settings().Meta.AppURL = "https://zoo.example"
	got := RuleMailHeaders(app, AutoForwarded)
	want := map[string]string{"Auto-Submitted": "auto-forwarded", "X-TinyCld-Loop": "zoo.example"}
	if !equalHeaders(got, want) {
		t.Fatalf("RuleMailHeaders = %v, want %v", got, want)
	}
}
