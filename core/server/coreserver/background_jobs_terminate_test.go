package coreserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/readonly/readonlytest"
	"tinycld.org/core/syscfg"
)

// The invite email, the invite notification and the boot notices run after
// the work that started them has returned. When the app terminates while one
// is still running, the terminate must wait for it: each touches the
// database again, and a read after the database closes panics the process.

// releaser returns a channel a held seam blocks on and the func that closes
// it. A test registers the func as a cleanup after every cleanup it must
// precede (an httptest server's Close, the app's Cleanup): cleanups run
// last-in first-out, so a failed assertion cannot leave them waiting forever
// on the held job.
func releaser() (<-chan struct{}, func()) {
	release := make(chan struct{})
	var once sync.Once
	return release, func() { once.Do(func() { close(release) }) }
}

// terminateHeld starts the app's terminate and fails the test when it
// returns within hold. It returns a channel closed when the terminate
// returns.
func terminateHeld(t *testing.T, app core.App, hold time.Duration, job string) <-chan struct{} {
	t.Helper()
	testApp, ok := app.(*tests.TestApp)
	if !ok {
		t.Fatalf("terminateHeld needs a *tests.TestApp, got %T", app)
	}
	terminated := make(chan struct{})
	go func() {
		testApp.Cleanup()
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatalf("terminate returned while the %s was still running", job)
	case <-time.After(hold):
	}
	return terminated
}

func awaitTerminated(t *testing.T, terminated <-chan struct{}, job string) {
	t.Helper()
	select {
	case <-terminated:
	case <-time.After(10 * time.Second):
		t.Fatalf("terminate did not return after the %s ended", job)
	}
}

// postInvite invites username as a member, through the endpoint, as owner.
func postInvite(t *testing.T, app *tests.TestApp, owner *core.Record, username string) {
	t.Helper()
	token, err := owner.NewAuthToken()
	if err != nil {
		t.Fatalf("NewAuthToken: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"username": username, "role": "member"})
	scenario := &tests.ApiScenario{
		Method:                http.MethodPost,
		URL:                   "/api/invite-member",
		Body:                  strings.NewReader(string(body)),
		Headers:               map[string]string{"Authorization": token},
		ExpectedStatus:        http.StatusOK,
		ExpectedContent:       []string{`"userId":`},
		TestAppFactory:        func(_ testing.TB) *tests.TestApp { return app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// usePostmarkStandIn points app's mailer at srv in place of Postmark.
func usePostmarkStandIn(t *testing.T, app core.App, srv *httptest.Server) {
	t.Helper()
	settings := map[string]string{
		"mail.provider":              "postmark",
		"mail.postmark_server_token": "test-server-token",
		"mail.postmark_api_url":      srv.URL,
	}
	syscfg.SetResolver(app, func(key string) string { return settings[key] })
}

// The email's send honours the job's ctx, so the terminate ends it at once;
// what must hold is the order: the terminate returns only after the send
// has returned. The send logs its failure as it returns, so the log is
// there by the time the terminate is.
func TestInvite_TerminateWaitsForTheExistingMemberEmail(t *testing.T) {
	app := setupInviteTestApp(t)
	owner := setUserRole(t, app, mustCreateUser(t, app, "owner@test.local", false), "owner")
	member := mustCreateUser(t, app, "member@test.local", false)
	logs := readonlytest.CaptureLogs(t)

	hit := make(chan struct{}, 1)
	release, letGo := releaser()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case hit <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"ErrorCode":0,"Message":"OK","MessageID":"stand-in"}`))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(letGo)
	usePostmarkStandIn(t, app, srv)

	registerInviteEndpointCore(app)
	postInvite(t, app, owner, member.GetString("username"))
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the existing member email never reached the mail provider")
	}

	app.Cleanup()

	r, ok := readonlytest.Find(logs(), "invite lifecycle: failed to send email")
	if !ok {
		t.Fatal("terminate returned before the existing member email's send had returned")
	}
	if !strings.Contains(r.Attrs["err"], context.Canceled.Error()) {
		t.Fatalf("the terminate must end the send through its ctx, got err %q", r.Attrs["err"])
	}
}

func TestInvite_TerminateWaitsForTheNotification(t *testing.T) {
	app, _ := inviteNotifyApp(t)
	testApp := app.(*tests.TestApp)
	owner := setUserRole(t, app, mustCreateUser(t, app, "owner@test.local", false), "owner")

	hit := make(chan struct{}, 1)
	saved := make(chan error, 1)
	release, letGo := releaser()
	t.Cleanup(letGo)
	app.OnRecordCreate("notifications").BindFunc(func(e *core.RecordEvent) error {
		select {
		case hit <- struct{}{}:
		default:
		}
		<-release
		err := e.Next()
		saved <- err
		return err
	})

	registerInviteEndpointCore(app)
	postInvite(t, testApp, owner, "newhire")
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the invite notification never reached its save")
	}

	terminated := terminateHeld(t, app, 300*time.Millisecond, "invite notification")
	letGo()
	select {
	case err := <-saved:
		if err != nil {
			t.Fatalf("the notification was saved against a closed database: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the notification was not saved after the hold ended")
	}
	awaitTerminated(t, terminated, "invite notification")
}

// A boot notice whose mail ignores the cancel still holds the terminate. The
// hold runs past 2 s: a bounded wait (the notices once had a 2 s one) would
// have let the terminate through by then, and the notice's later writes would
// have met a closed database.
func TestBootNotices_TerminateWaitsForTheNotices(t *testing.T) {
	app := unrestoredTestApp(t)
	keepUnrestored(t, "build-9", true)

	mailing := make(chan struct{})
	release, letGo := releaser()
	t.Cleanup(letGo)
	startBootNotices(app, func(context.Context, core.App, notice) error {
		close(mailing)
		<-release
		return nil
	})
	awaitClosed(t, mailing, "the boot notice to start its email")

	terminated := terminateHeld(t, app, 2500*time.Millisecond, "boot notice job")
	letGo()
	awaitTerminated(t, terminated, "boot notice job")
}
