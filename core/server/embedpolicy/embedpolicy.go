// Package embedpolicy decides which origins may frame a given page.
//
// The app sets `Content-Security-Policy: frame-ancestors` on every HTML
// response it serves (coreserver's writeAppShell). The default is 'none': the
// workspace must never be framable, because a framed workspace is a
// clickjacking target and nothing in the product needs it.
//
// The exception is a package's PUBLIC share surface. A board shared by link is
// exactly the kind of thing someone wants to drop into a wiki or an intranet
// page, and whether a given link may be framed — and by whom — is a fact only
// that package knows: it lives on the package's own link row, behind the
// package's own access rules.
//
// So core does not look it up. A package registers a resolver from its
// Register(app) and core asks every registered resolver, exactly as
// oauth.RegisterPackage and search.RegisterSources invert the same dependency.
// Core therefore names no package, no slug and no collection, and a deployment
// without that package simply has no resolver to ask and frames nothing.
package embedpolicy

import (
	"net/http"
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// Resolver answers "may this request's page be framed, and by whom?".
//
// Return the allowed origins, or nil to express no opinion. Nil is not
// "deny" — it is "not mine", which is what every resolver returns for every
// path but its own; the DENIAL is the caller's default when no resolver
// claims the request. A resolver that recognises the path but finds the link
// revoked, expired or non-embeddable also returns nil, and the same default
// covers it.
//
// Called on the request path of an HTML response, so it should be one indexed
// lookup at most. The request is read-only.
type Resolver func(r *http.Request) []string

// resolvers is one app's registered resolvers. Each app keeps its own: a
// resolver looks the request up in its app's database, so running it for
// another app's request would read the wrong data and could grant framing on
// a token that only exists there.
type resolvers struct {
	mu   sync.RWMutex
	list []Resolver
}

var resolversKey = appstate.NewKey[*resolvers]("embedpolicy.resolvers")

func resolversFor(app core.App) *resolvers {
	return resolversKey.GetOrInit(app, func() *resolvers { return &resolvers{} })
}

// Register adds a resolver for app. Called from a package's Register(app).
func Register(app core.App, fn Resolver) {
	if fn == nil {
		return
	}
	r := resolversFor(app)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.list = append(r.list, fn)
}

// FrameAncestors returns the CSP `frame-ancestors` value for a request app
// serves, asking only app's resolvers.
//
// Always returns a complete, non-empty directive value, so the caller can
// write it unconditionally and cannot accidentally omit the header on the path
// where it matters most. With no resolver claiming the request that value is
// 'none'.
//
// FIRST claim wins, and a claim is not re-checked against later resolvers: two
// packages cannot both own one URL, and consulting the rest could only widen
// what the first one decided.
func FrameAncestors(app core.App, r *http.Request) string {
	res := resolversFor(app)
	res.mu.RLock()
	defer res.mu.RUnlock()

	for _, fn := range res.list {
		if origins := fn(r); len(origins) > 0 {
			return joinOrigins(origins)
		}
	}
	return "'none'"
}

// joinOrigins builds the directive value.
//
// Origins are written verbatim — validating them is the registering package's
// job, at the point they are STORED rather than every time they are read.
// That split is deliberate: a value that reached the database unvalidated
// cannot be made safe here, because CSP has no escaping, and pretending
// otherwise would move the check somewhere it cannot report the error to
// whoever typed it.
func joinOrigins(origins []string) string {
	out := ""
	for i, origin := range origins {
		if i > 0 {
			out += " "
		}
		out += origin
	}
	return out
}
