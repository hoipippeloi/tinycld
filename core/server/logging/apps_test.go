package logging_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/logger"

	"tinycld.org/core/background"
	"tinycld.org/core/logging"
	"tinycld.org/core/multiapptest"
)

// flushLogs writes app's queued log records to its _logs table now, instead
// of on PocketBase's 3 s ticker.
func flushLogs(t *testing.T, app core.App) {
	t.Helper()
	h, ok := app.Logger().Handler().(*logger.BatchHandler)
	if !ok {
		t.Fatalf("app logger handler is %T, want *logger.BatchHandler", app.Logger().Handler())
	}
	if err := h.WriteAll(context.WithValue(context.Background(), logger.BlockKey, true)); err != nil {
		t.Fatal(err)
	}
}

// logRows returns app's _logs rows whose message is msg.
func logRows(t *testing.T, app core.App, msg string) []*core.Log {
	t.Helper()
	var rows []*core.Log
	err := app.LogQuery().AndWhere(dbx.HashExp{"message": msg}).All(&rows)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func expectRows(t *testing.T, app core.App, name, msg string, want int) []*core.Log {
	t.Helper()
	rows := logRows(t, app, msg)
	if len(rows) != want {
		t.Errorf("app %s has %d %q rows in _logs, want %d", name, len(rows), msg, want)
	}
	return rows
}

// syncBuffer is a bytes.Buffer safe for the background job's goroutine.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestRecordsReachOnlyTheAppInTheirContext(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]

	stderr := &syncBuffer{}
	t.Cleanup(logging.InstallTo(stderr))

	ctxA := logging.WithApp(context.Background(), a)
	slog.InfoContext(ctxA, "multiapp: plain record for A")
	logging.ForPackage("widgets").With("widgetID", "w1").InfoContext(ctxA, "multiapp: package record for A")
	slog.Info("multiapp: record with no app")

	// A background job of app B logs with the ctx it is given.
	done := make(chan struct{})
	background.For(b, "widgets").Run("multiapp log", func(ctx context.Context) {
		defer close(done)
		slog.InfoContext(ctx, "multiapp: background record for B")
	})
	<-done

	flushLogs(t, a)
	flushLogs(t, b)

	expectRows(t, a, "A", "multiapp: plain record for A", 1)
	expectRows(t, b, "B", "multiapp: plain record for A", 0)

	rows := expectRows(t, a, "A", "multiapp: package record for A", 1)
	expectRows(t, b, "B", "multiapp: package record for A", 0)
	if len(rows) == 1 && (rows[0].Data["pkg"] != "widgets" || rows[0].Data["widgetID"] != "w1") {
		t.Errorf("package record data = %v, want pkg=widgets widgetID=w1", rows[0].Data)
	}

	expectRows(t, b, "B", "multiapp: background record for B", 1)
	expectRows(t, a, "A", "multiapp: background record for B", 0)

	expectRows(t, a, "A", "multiapp: record with no app", 0)
	expectRows(t, b, "B", "multiapp: record with no app", 0)

	for _, msg := range []string{
		"multiapp: plain record for A",
		"multiapp: record with no app",
		"multiapp: background record for B",
	} {
		if !strings.Contains(stderr.String(), msg) {
			t.Errorf("stderr is missing %q:\n%s", msg, stderr.String())
		}
	}
}

// The default app is how a one-app process keeps its records with no app in
// their context: they land in that app's _logs and nowhere else.
func TestRecordsWithNoAppGoToTheDefaultApp(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]

	t.Cleanup(logging.InstallTo(&syncBuffer{}))
	logging.SetDefaultApp(a)
	t.Cleanup(func() { logging.SetDefaultApp(nil) })

	slog.Info("multiapp: no-app record with a default app")
	flushLogs(t, a)
	flushLogs(t, b)

	expectRows(t, a, "A", "multiapp: no-app record with a default app", 1)
	expectRows(t, b, "B", "multiapp: no-app record with a default app", 0)
}

// recordingTransport keeps the events a client sends.
type recordingTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (r *recordingTransport) Configure(sentry.ClientOptions) {}
func (r *recordingTransport) SendEvent(e *sentry.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}
func (r *recordingTransport) Flush(time.Duration) bool              { return true }
func (r *recordingTransport) FlushWithContext(context.Context) bool { return true }
func (r *recordingTransport) Close()                                {}

func (r *recordingTransport) messages() map[string]map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]map[string]string{}
	for _, e := range r.events {
		out[e.Message] = e.Tags
	}
	return out
}

func bindRecorder(t *testing.T, app core.App) *recordingTransport {
	t.Helper()
	tr := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://k@example.test/1", Transport: tr})
	if err != nil {
		t.Fatal(err)
	}
	logging.Hub(app).BindClient(client)
	return tr
}

func TestEachAppReportsToItsOwnSentryHub(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	t.Cleanup(logging.InstallTo(&syncBuffer{}))

	if logging.Hub(a) == logging.Hub(b) {
		t.Fatal("two apps share one Sentry hub")
	}
	if logging.Hub(a) != logging.Hub(a) {
		t.Fatal("Hub returned a different hub for the same app")
	}
	trA, trB := bindRecorder(t, a), bindRecorder(t, b)
	logging.Hub(a).Scope().SetTag("org", "a")

	slog.WarnContext(logging.WithApp(context.Background(), a), "multiapp: warning for A")
	slog.WarnContext(logging.WithApp(context.Background(), b), "multiapp: warning for B")

	gotA, gotB := trA.messages(), trB.messages()
	if tags, ok := gotA["multiapp: warning for A"]; !ok || tags["org"] != "a" {
		t.Errorf("app A's hub events = %v, want its warning tagged org=a", gotA)
	}
	if _, ok := gotA["multiapp: warning for B"]; ok {
		t.Error("app B's warning reached app A's hub")
	}
	tagsB, ok := gotB["multiapp: warning for B"]
	if !ok {
		t.Errorf("app B's hub events = %v, want its warning", gotB)
	}
	if _, tagged := tagsB["org"]; tagged {
		t.Error("a tag set on app A's hub reached app B's event")
	}
	if _, ok := gotB["multiapp: warning for A"]; ok {
		t.Error("app A's warning reached app B's hub")
	}
}
