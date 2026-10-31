package ratelimit

import (
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// PerApp is a limiter definition whose counts live on each app. A process
// can run several apps, and a package-level *Limiter would let one app's
// traffic spend another app's budget. Declare a PerApp once as a
// package-level variable (the limit and window are code-level), and call For
// with the request's app.
type PerApp struct {
	key    appstate.Key[*Limiter]
	limit  int
	window time.Duration
}

// NewPerApp defines a limiter of limit events per window for each key, kept
// per app. name must be unique in the process; use "<pkg>.<what>".
func NewPerApp(name string, limit int, window time.Duration) PerApp {
	return PerApp{
		key:    appstate.NewKey[*Limiter]("ratelimit." + name),
		limit:  limit,
		window: window,
	}
}

// For returns app's limiter, making it on first use.
func (p PerApp) For(app core.App) *Limiter {
	return p.key.GetOrInit(app, func() *Limiter { return New(p.limit, p.window) })
}
