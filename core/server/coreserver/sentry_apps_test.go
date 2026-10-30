package coreserver_test

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/logger"

	"tinycld.org/core/logging"
	"tinycld.org/core/multiapptest"
)

type appEvents struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (r *appEvents) Configure(sentry.ClientOptions) {}
func (r *appEvents) SendEvent(e *sentry.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}
func (r *appEvents) Flush(time.Duration) bool              { return true }
func (r *appEvents) FlushWithContext(context.Context) bool { return true }
func (r *appEvents) Close()                                {}

func (r *appEvents) snapshot() []*sentry.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*sentry.Event(nil), r.events...)
}

// boomRoute mounts a route that logs a record with the request's ctx and
// then fails, so one request exercises both the log routing and the Sentry
// middleware.
func boomRoute(app *pocketbase.PocketBase, marker string) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/multiapp-boom", func(re *core.RequestEvent) error {
			slog.InfoContext(re.Request.Context(), marker)
			return errors.New("boom from " + marker)
		})
		return e.Next()
	})
}

func logCount(t *testing.T, app core.App, msg string) int {
	t.Helper()
	h, ok := app.Logger().Handler().(*logger.BatchHandler)
	if !ok {
		t.Fatalf("app logger handler is %T", app.Logger().Handler())
	}
	if err := h.WriteAll(context.WithValue(context.Background(), logger.BlockKey, true)); err != nil {
		t.Fatal(err)
	}
	var rows []*core.Log
	if err := app.LogQuery().AndWhere(dbx.HashExp{"message": msg}).All(&rows); err != nil {
		t.Fatal(err)
	}
	return len(rows)
}

// A request served by one app logs to that app's _logs and reports to that
// app's Sentry hub, with that app's tags, and touches neither of the other's.
func TestRequestLogsAndErrorsStayWithTheServingApp(t *testing.T) {
	apps := multiapptest.NewApps(t, 2)
	a, b := apps[0], apps[1]
	boomRoute(a, "multiapp: request log on A")
	boomRoute(b, "multiapp: request log on B")
	ha, hb := multiapptest.Serve(t, a), multiapptest.Serve(t, b)

	trA, trB := &appEvents{}, &appEvents{}
	for app, tr := range map[core.App]*appEvents{a: trA, b: trB} {
		client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://k@example.test/1", Transport: tr})
		if err != nil {
			t.Fatal(err)
		}
		logging.Hub(app).BindClient(client)
	}
	logging.Hub(a).Scope().SetTag("org", "a")

	rec := httptest.NewRecorder()
	ha.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/multiapp-boom", nil))
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /multiapp-boom on A = %d", rec.Code)
	}

	eventsA := trA.snapshot()
	if len(eventsA) != 1 || eventsA[0].Tags["org"] != "a" {
		t.Errorf("app A's Sentry events = %+v, want one tagged org=a", eventsA)
	}
	if got := trB.snapshot(); len(got) != 0 {
		t.Errorf("app A's error reached app B's Sentry hub: %+v", got)
	}
	if n := logCount(t, a, "multiapp: request log on A"); n != 1 {
		t.Errorf("app A has %d request log rows, want 1", n)
	}
	if n := logCount(t, b, "multiapp: request log on A"); n != 0 {
		t.Errorf("app B has %d of app A's request log rows, want 0", n)
	}

	rec = httptest.NewRecorder()
	hb.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/multiapp-boom", nil))
	eventsB := trB.snapshot()
	if len(eventsB) != 1 {
		t.Fatalf("app B's Sentry events = %+v, want one", eventsB)
	}
	if _, tagged := eventsB[0].Tags["org"]; tagged {
		t.Error("app A's tag reached app B's event")
	}
	if n := logCount(t, b, "multiapp: request log on B"); n != 1 {
		t.Errorf("app B has %d request log rows, want 1", n)
	}
}
