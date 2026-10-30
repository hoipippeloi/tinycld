// Package sendquota is core's policy seam for outbound mail ceilings.
//
// Two ceilings, and the second is the reason this package exists rather than
// a single number in the deployment's own settings.
//
// PerDay is the ordinary volume limit: how much mail a deployment may send in
// a normal day.
//
// PerHour is the THROTTLE. When outbound mail starts generating bounces or
// spam complaints at a rate that threatens the sending reputation everyone
// else shares, whoever is watching drops this to a trickle and leaves it
// there pending a human review. That is deliberately not a suspension: a
// throttled deployment keeps receiving mail, keeps its data, keeps working,
// and can still send the handful of replies a real conversation needs. It
// simply cannot blast.
//
// Both are resolved through a seam rather than read from the deployment's own
// settings, for the reason quota and sharequota both state: every deployment
// has its own superusers, so a ceiling stored inside one is a ceiling that
// deployment can raise — and a throttle its subject can lift is not a
// throttle.
package sendquota

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/appstate"
)

// SendLimits are the outbound ceilings. Zero means UNLIMITED in both fields,
// matching quota.Limits and sharequota.ShareLimits — one convention across
// every ceiling in the ecosystem.
type SendLimits struct {
	// PerDay bounds ordinary volume over a UTC calendar day.
	PerDay int

	// PerHour bounds a rolling hour and is normally zero. It is set when a
	// deployment is under review, so that a send run in progress stops within
	// the hour rather than at midnight.
	PerHour int
}

// SendLimitsFunc resolves the current ceilings. Called on the send path, so
// it must be cheap — a struct read, not a query.
type SendLimitsFunc func(app core.App) SendLimits

// claim is one app's resolver and whether it has been claimed. It lives on the
// app: two apps in one process are two deployments, and each is throttled on
// its own record, never on its neighbour's.
type claim struct {
	mu      sync.RWMutex
	limits  SendLimitsFunc
	claimed bool
}

var claimKey = appstate.NewKey[*claim]("sendquota.limits")

func claimFor(app core.App) *claim {
	return claimKey.GetOrInit(app, func() *claim { return &claim{} })
}

// SetLimits installs app's resolver. A supervising composition calls it
// before any package registers on app.
//
// This CLAIMS app's seam: a later call on app is ignored, so nothing can point
// app's ceilings back at a value the deployment controls. That matters more
// here than for a storage ceiling — the throttle exists precisely for a
// deployment that is behaving badly, and one that could raise its own limit
// would simply do so.
//
// A nil resolver is ignored rather than installed: it would silently mean
// unlimited, and a caller passing nil has a bug rather than an intent.
func SetLimits(app core.App, fn SendLimitsFunc) {
	if fn == nil {
		return
	}
	c := claimFor(app)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.claimed {
		return
	}
	c.limits, c.claimed = fn, true
}

// IsClaimed reports whether a supervising composition installed app's
// resolver. A standalone deployment's own wiring consults this before falling
// back to what that deployment configured for itself.
func IsClaimed(app core.App) bool {
	c := claimFor(app)
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.claimed
}

// Limits resolves app's current ceilings, or unlimited when nobody claimed
// app's seam. A negative value is normalized to zero here rather than at the
// call site: a negative ceiling reaching an enforcement comparison would
// refuse every send, and that must not depend on whoever supplies the numbers
// having validated them.
func Limits(app core.App) SendLimits {
	c := claimFor(app)
	c.mu.RLock()
	fn := c.limits
	c.mu.RUnlock()

	if fn == nil {
		return SendLimits{}
	}
	l := fn(app)
	if l.PerDay < 0 {
		l.PerDay = 0
	}
	if l.PerHour < 0 {
		l.PerHour = 0
	}
	return l
}
