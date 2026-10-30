package realtime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/logging"
)

type giveUpTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (g *giveUpTransport) Configure(sentry.ClientOptions) {}
func (g *giveUpTransport) SendEvent(e *sentry.Event) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.events = append(g.events, e)
}
func (g *giveUpTransport) Flush(time.Duration) bool              { return true }
func (g *giveUpTransport) FlushWithContext(context.Context) bool { return true }
func (g *giveUpTransport) Close()                                {}

func (g *giveUpTransport) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.events)
}

func bindRecordingHub(t *testing.T, app core.App) *giveUpTransport {
	t.Helper()
	tr := &giveUpTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://k@example.test/1", Transport: tr})
	if err != nil {
		t.Fatal(err)
	}
	logging.Hub(app).BindClient(client)
	return tr
}

// A save give-up belongs to the app whose room gave up: it is reported on that
// app's Sentry hub, never on the process hub or another app's.
func TestGiveUpReportsToTheCoordinatorsApp(t *testing.T) {
	a := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	b := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	ta, tb := bindRecordingHub(t, a), bindRecordingHub(t, b)

	c := NewSaveCoordinator(a, func(context.Context, string, DocHandle) error { return nil })
	c.captureGiveUp(giveUpDetail{DriveItemID: "item", Kind: "text", Reason: "test", Attempts: 3, Err: errors.New("boom")})

	if ta.count() != 1 {
		t.Fatalf("app A's hub got %d events, want 1", ta.count())
	}
	if tb.count() != 0 {
		t.Fatalf("app B's hub got app A's give-up: %d events", tb.count())
	}
}
