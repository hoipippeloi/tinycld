package logging

import (
	"context"
	"log"

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
	Hub(app).BindClient(client)
}
