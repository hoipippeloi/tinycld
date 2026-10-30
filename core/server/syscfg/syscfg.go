// Package syscfg is the indirection through which core reads system-wide
// configuration — the "use-your-own-service" values (Sentry, web push, mail
// provider credentials) stored in the system_settings collection.
//
// By default it reads that collection, exactly as the code did before this
// package existed, so a standalone deployment behaves identically. The reason
// it is an indirection at all is that a SUPERVISING composition — a process
// that owns this app's runtime wiring rather than discovering it — may own
// these values instead, and must be able to say so without core knowing
// anything about what that supervisor is.
//
// This is the same seam quota already has: SettingsLimits reads the org's own
// database, FixedLimits takes the ceiling from whoever composed the app. The
// reason is identical, and worth restating because it is the whole point —
// every deployment has its own superusers, so a value stored inside the
// deployment can be changed by that deployment. A value its operator must own
// therefore cannot live there.
//
// It is a package of its own rather than a member of coreserver so that push,
// mailer and feature packages can read through it without an import cycle.
// Nothing here imports coreserver.
package syscfg

import (
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// Provider resolves a system-settings key and declares which key namespaces
// its supplier owns.
//
// ManagedPrefixes returns dotted key prefixes ("sentry.", "vapid.", "mail.").
// A managed namespace is one this deployment must not edit for itself: core
// refuses writes to those keys and hides the UI that would edit them. The
// default provider manages nothing, which is what makes a standalone
// deployment fully self-administered.
type Provider interface {
	Get(key string) string
	// ManagedPrefixes may return an internal slice; callers must not retain or
	// mutate it. The package-level ManagedPrefixes copies before handing it out.
	ManagedPrefixes() []string
}

// seam is one app's provider. It lives on the app because two apps in one
// process are two deployments: each may be supervised or standalone, and one
// app's operator-owned credentials must never answer another app's read.
type seam struct {
	mu      sync.RWMutex
	current Provider
	// claimed records that a SUPERVISING composition installed the provider,
	// as opposed to this deployment pointing the seam at its own collection.
	//
	// Tracked explicitly rather than inferred from ManagedPrefixes() being
	// non-empty, because those are different questions and conflating them is
	// a security bug: a supervisor whose config failed to load installs a
	// provider that manages nothing yet, and core would then take the seam
	// back and hand the deployment its own settings — exactly the fallback the
	// supervisor exists to prevent.
	claimed bool
}

var seamKey = appstate.NewKey[*seam]("syscfg.seam")

func seamFor(app core.App) *seam {
	return seamKey.GetOrInit(app, func() *seam { return &seam{current: unmanaged{}} })
}

func (s *seam) provider() Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

// unmanaged is the zero provider: it resolves nothing and manages nothing. It
// stands in before SetProvider or SetResolver runs so that a Get during boot
// returns "" rather than panicking, matching SystemConfig's own behaviour
// before its first load.
type unmanaged struct{}

func (unmanaged) Get(string) string         { return "" }
func (unmanaged) ManagedPrefixes() []string { return nil }

// resolverProvider adapts a plain lookup func to Provider, managing nothing.
// This is the standalone shape: core's own SystemConfig.Get supplies values and
// the deployment administers every one of them itself.
type resolverProvider struct{ get func(string) string }

func (r resolverProvider) Get(key string) string   { return r.get(key) }
func (resolverProvider) ManagedPrefixes() []string { return nil }

// SetResolver points app's seam at the deployment's own settings — what
// coreserver calls with SystemConfig.Get once the collection is loadable.
//
// Ignored once a supervising composition has claimed app's seam. Core's wiring
// runs after a supervisor's, so without this the deployment would silently
// reclaim settings its operator owns.
func SetResolver(app core.App, get func(key string) string) {
	if get == nil {
		return
	}
	s := seamFor(app)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed {
		return
	}
	s.current = resolverProvider{get: get}
}

// SetProvider installs app's provider. A supervising composition calls this
// BEFORE any package registers on app, so that every consumer's first read
// already resolves through it.
//
// This CLAIMS app's seam: SetResolver becomes a no-op on app afterwards, so
// core's own wiring cannot later point these reads back at this deployment's
// collection. That matters most in the failure case — a supervisor whose
// config would not load still owns these settings, and the correct degraded
// state is "no mail, no push, no error reporting", never "the deployment
// supplies its own".
//
// A nil provider is ignored rather than installed: losing the resolver would
// turn every subsequent read into "" — silently disabling mail, push and error
// reporting — and a caller that passes nil has a bug, not an intent.
func SetProvider(app core.App, p Provider) {
	if p == nil {
		return
	}
	s := seamFor(app)
	s.mu.Lock()
	s.current, s.claimed = p, true
	s.mu.Unlock()
}

// IsClaimed reports whether a supervising composition installed app's provider.
func IsClaimed(app core.App) bool {
	s := seamFor(app)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.claimed
}

// Get resolves a key through app's provider. Unset keys return "".
func Get(app core.App, key string) string {
	return seamFor(app).provider().Get(key)
}

// ManagedPrefixes reports the key namespaces app's provider owns. Empty on a
// standalone deployment.
//
// The result is a copy: callers range over it outside the lock, and a Provider
// that returned its live backing array would race with its own next update.
func ManagedPrefixes(app core.App) []string {
	prefixes := seamFor(app).provider().ManagedPrefixes()
	out := make([]string, len(prefixes))
	copy(out, prefixes)
	return out
}

// IsManaged reports whether key falls in a namespace app's provider owns, and
// so must not be written or edited from inside this deployment.
//
// An empty prefix is ignored rather than treated as "everything": it would
// match every key and lock the deployment out of its own settings, which is
// never what a supplier of an empty list meant.
func IsManaged(app core.App, key string) bool {
	for _, prefix := range ManagedPrefixes(app) {
		if prefix == "" {
			continue
		}
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}
