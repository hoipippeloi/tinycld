package logging_test

import (
	"sync/atomic"
	"testing"

	"github.com/getsentry/sentry-go"

	"tinycld.org/core/logging"
	"tinycld.org/core/multiapptest"
)

// closeRecorder stands in for a client's transport and records its Close.
type closeRecorder struct {
	sentry.Transport
	closed atomic.Bool
}

func (r *closeRecorder) Close() { r.closed.Store(true) }

func recordClose(hub *sentry.Hub) *closeRecorder {
	rec := &closeRecorder{Transport: hub.Client().Transport}
	hub.Client().Transport = rec
	return rec
}

// A client's HTTP transport runs a worker goroutine until it is closed. A DSN
// edited in an app's settings binds a new client, so the one it replaces must
// be closed, or every edit leaves a worker running for the life of the process.
func TestInitAppSentryClosesTheClientItReplaces(t *testing.T) {
	app := multiapptest.NewApps(t, 1)[0]
	logging.InitAppSentry(app, "")
	old := recordClose(logging.Hub(app))

	logging.InitAppSentry(app, "")

	if !old.closed.Load() {
		t.Fatal("the replaced Sentry client was not closed")
	}
}

// An app that terminates while its process keeps running must close its own
// client, for the same reason.
func TestTerminateClosesTheAppsSentryClient(t *testing.T) {
	app := multiapptest.NewApps(t, 1)[0]
	logging.InitAppSentry(app, "")
	rec := recordClose(logging.Hub(app))

	multiapptest.Terminate(t, app)

	if !rec.closed.Load() {
		t.Fatal("terminate did not close the app's Sentry client")
	}
}

// Until InitAppSentry binds its own client, an app's hub shares the process's
// client. That client serves every other app too, so an app's terminate must
// leave it open.
func TestTerminateLeavesTheSharedProcessClientOpen(t *testing.T) {
	process := sentry.CurrentHub()
	prev := process.Client()
	shared, err := sentry.NewClient(sentry.ClientOptions{})
	if err != nil {
		t.Fatal(err)
	}
	process.BindClient(shared)
	t.Cleanup(func() { process.BindClient(prev) })
	rec := recordClose(process)

	app := multiapptest.NewApps(t, 1)[0]
	logging.Hub(app)
	multiapptest.Terminate(t, app)

	if rec.closed.Load() {
		t.Fatal("an app's terminate closed the process's shared Sentry client")
	}
}
