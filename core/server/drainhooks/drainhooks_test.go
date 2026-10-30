package drainhooks

import (
	"reflect"
	"sync"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func bareApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

func terminate(app core.App) {
	_ = app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(*core.TerminateEvent) error { return nil })
}

// recorder collects handler names from any goroutine.
type recorder struct {
	mu  sync.Mutex
	got []string
}

func (r *recorder) fn(name string) func() {
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.got = append(r.got, name)
	}
}

func (r *recorder) names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.got...)
}

func TestRunBeginCallsEveryHandlerInOrder(t *testing.T) {
	t.Cleanup(ResetForTest)
	app := bareApp(t)
	rec := &recorder{}
	OnBegin(app, "acme-listeners", rec.fn("acme-listeners"))
	OnBegin(app, "acme-queue", rec.fn("acme-queue"))

	RunBegin(app)
	if want := []string{"acme-listeners", "acme-queue"}; !reflect.DeepEqual(rec.names(), want) {
		t.Fatalf("handlers ran %v, want %v", rec.names(), want)
	}
}

// A package registers from its Register(), which can run again (a dev
// reload); the second registration replaces the first instead of running
// the handler twice.
func TestOnBeginReplacesASameNamedHandler(t *testing.T) {
	t.Cleanup(ResetForTest)
	app := bareApp(t)
	rec := &recorder{}
	OnBegin(app, "acme-listeners", rec.fn("first"))
	OnBegin(app, "acme-listeners", rec.fn("second"))

	RunBegin(app)
	if want := []string{"second"}; !reflect.DeepEqual(rec.names(), want) {
		t.Fatalf("handlers ran %v, want only the second", rec.names())
	}
}

// One package's panic must not keep the next package's listeners open.
func TestRunBeginSurvivesAPanickingHandler(t *testing.T) {
	t.Cleanup(ResetForTest)
	app := bareApp(t)
	rec := &recorder{}
	OnBegin(app, "acme-broken", func() { panic("boom") })
	OnBegin(app, "acme-listeners", rec.fn("acme-listeners"))

	RunBegin(app)
	if len(rec.names()) != 1 {
		t.Fatal("a panicking handler stopped the handlers after it")
	}
}

func TestRunBeginWithNothingRegistered(t *testing.T) {
	t.Cleanup(ResetForTest)
	RunBegin(bareApp(t))
	RunBeginAll()
}

// Two apps register the same name: each keeps its own handler, and draining
// one app runs only that app's.
func TestHandlersArePerApp(t *testing.T) {
	t.Cleanup(ResetForTest)
	a, b := bareApp(t), bareApp(t)
	rec := &recorder{}
	OnBegin(a, "acme-listeners", rec.fn("a"))
	OnBegin(b, "acme-listeners", rec.fn("b"))

	RunBegin(a)
	if want := []string{"a"}; !reflect.DeepEqual(rec.names(), want) {
		t.Fatalf("draining a ran %v, want only a's handler", rec.names())
	}
}

// A process drain runs every app's handlers; an app that terminated is no
// longer part of the process and is skipped.
func TestRunBeginAllRunsEveryLiveAppsHandlers(t *testing.T) {
	t.Cleanup(ResetForTest)
	ResetForTest()
	a, b, gone := bareApp(t), bareApp(t), bareApp(t)
	rec := &recorder{}
	OnBegin(a, "acme-listeners", rec.fn("a"))
	OnBegin(b, "acme-listeners", rec.fn("b"))
	OnBegin(gone, "acme-listeners", rec.fn("gone"))
	terminate(gone)

	RunBeginAll()
	if want := []string{"a", "b"}; !reflect.DeepEqual(rec.names(), want) {
		t.Fatalf("the process drain ran %v, want %v", rec.names(), want)
	}
}
