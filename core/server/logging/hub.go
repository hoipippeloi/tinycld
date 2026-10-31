package logging

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// hubKey holds each app's own Sentry hub, so one app's client (its DSN) and
// its scope tags never reach another app's events.
var hubKey = appstate.NewKey[*sentry.Hub]("logging.sentryHub")

func processHub() *sentry.Hub { return sentry.CurrentHub() }

// Hub returns app's Sentry hub. It starts as a clone of the process hub, so
// it reports through whatever client the process has until InitAppSentry
// binds the app's own. For the app SetDefaultApp named it is the process hub
// itself. Set scope tags for an app here, never on sentry.CurrentHub().
func Hub(app core.App) *sentry.Hub {
	return hubKey.GetOrInit(app, func() *sentry.Hub { return processHub().Clone() })
}

// HubFromContext is the hub a capture made under ctx reports to: the
// per-request hub when the Sentry middleware put one there, else the hub of
// the app on ctx, else the process hub.
func HubFromContext(ctx context.Context) *sentry.Hub {
	if ctx != nil {
		if hub := sentry.GetHubFromContext(ctx); hub != nil {
			return hub
		}
		if app, ok := AppFrom(ctx); ok {
			return Hub(app)
		}
	}
	return processHub()
}

// InitAppSentry binds a client for dsn to app's hub. Safe to call again: the
// new client replaces the old one for every later capture, which is how a DSN
// edited in the app's settings takes effect. An empty dsn makes the app's
// hub a no-op, as InitSentry does for the process.
func InitAppSentry(app core.App, dsn string) {
	client, err := sentry.NewClient(clientOptions(dsn))
	if err != nil {
		// Stdlib log for the reason InitSentry gives.
		log.Printf("Sentry initialization failed: %v", err)
		return
	}
	first := false
	own := ownClientKey.GetOrInit(app, func() *ownClient { first = true; return &ownClient{} })
	if first {
		app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
			err := e.Next()
			own.replace(nil, nil)
			return err
		})
	}
	own.replace(Hub(app), client)
}

// ownClientKey holds the client InitAppSentry last bound for an app. Until
// then the app's hub shares the process's client, which serves other apps
// too, so only a client held here is the app's to close.
var ownClientKey = appstate.NewKey[*ownClient]("logging.sentryClient")

// clientCloseTimeout bounds the flush of a client being let go.
const clientCloseTimeout = 2 * time.Second

type ownClient struct {
	mu     sync.Mutex
	client *sentry.Client
}

// replace binds next to hub (when next is set) and closes the client it
// replaces. A client's HTTP transport runs a worker goroutine until closed,
// so a DSN edit or a terminate that dropped it would leave one running.
func (o *ownClient) replace(hub *sentry.Hub, next *sentry.Client) {
	o.mu.Lock()
	prev := o.client
	o.client = next
	if next != nil {
		hub.BindClient(next)
	}
	o.mu.Unlock()
	if prev != nil {
		prev.Flush(clientCloseTimeout)
		prev.Close()
	}
}
