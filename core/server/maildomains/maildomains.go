// Package maildomains is the indirection through which a mail feature performs
// the domain operations that require the operator's ACCOUNT-level mail-provider
// credentials — enrolling a sending domain and reading back its verification
// state and DNS records.
//
// It exists for the same reason syscfg does, one level up. syscfg delegates a
// VALUE a deployment must not hold; this delegates an OPERATION a deployment
// must not perform. Every call in Postmark's Domains API is account-token
// authenticated, including the reads, and an account token can enumerate,
// modify and delete every domain on the account — so in a deployment where
// one provider account is shared by many orgs, the token cannot live in an
// org's own app process at any privilege, and the operation must travel to
// whoever holds it instead.
//
// By default it is unconfigured and every call returns ErrNotConfigured. A
// standalone deployment points an app at its own implementation with
// SetResolver; a SUPERVISING composition installs one on an app with
// SetRegistrar, which CLAIMS that app's seam so the deployment's own wiring
// cannot later reclaim it. Each call acts on one app only.
//
// Nothing here names a feature package: this is a capability, like mailer and
// syscfg beside it.
package maildomains

import (
	"context"
	"errors"
	"github.com/pocketbase/pocketbase/core"
	"sync"
	"tinycld.org/core/appstate"
)

// ErrNotConfigured is returned by the zero registrar. Callers surface it as
// "domain provisioning is not configured for this deployment" rather than as
// an opaque provider failure.
var ErrNotConfigured = errors.New("maildomains: no registrar configured")

// DomainRecords is the verification state of a sending domain plus the DNS
// records its owner must publish.
//
// Deliberately pure data with no credential of any kind: it is the wire type
// of the delegating implementation, so everything on it crosses a process
// boundary into an org's own app process that must not be trusted with the
// account token.
type DomainRecords struct {
	Domain string `json:"domain"`
	ID     int64  `json:"id"`
	// SPFVerified is DEPRECATED by postmark@v1.9.0: Postmark no longer asks
	// senders to publish an SPF record, so this is expected to stay false on
	// every domain going forward. It is carried here for wire compatibility
	// (existing callers/consumers of this struct) and for any non-Postmark
	// provider that might still report it meaningfully.
	SPFVerified          bool   `json:"spf_verified"`
	DKIMVerified         bool   `json:"dkim_verified"`
	ReturnPathVerified   bool   `json:"return_path_verified"`
	DKIMHost             string `json:"dkim_host,omitempty"`
	DKIMTextValue        string `json:"dkim_text_value,omitempty"`
	ReturnPathDomain     string `json:"return_path_domain,omitempty"`
	ReturnPathCNAMEValue string `json:"return_path_cname_value,omitempty"`
}

// Registrar performs the account-token operations.
//
// AddDomain enrolls the domain with the provider and returns its initial
// records. GetDomain reads back the current state of an already-enrolled
// domain. Both take plain data and return plain data, which is what lets a
// shared-account implementation be a transport.
type Registrar interface {
	AddDomain(ctx context.Context, domain string) (*DomainRecords, error)

	// GetDomain reads the current state of an enrolled domain.
	//
	// providerDomainID is the provider's own id, or 0 when it is not known — a
	// row enrolled before the id was stored. A zero id forces a by-name lookup,
	// which is why it is worth persisting the id from the returned records:
	// Postmark has no lookup-by-name, so the fallback must page the account's
	// whole domain list and would report a domain past the first page as
	// unenrolled.
	GetDomain(ctx context.Context, domain string, providerDomainID int64) (*DomainRecords, error)
}

// Verifier is an OPTIONAL registrar capability: ask the provider to re-check
// the domain's DKIM and Return-Path records now, and return the fresh state.
// Callers type-assert Current(app) for it, so a registrar that cannot verify on
// demand (or a transport that does not forward it) keeps compiling.
//
// providerDomainID follows GetDomain's contract: 0 forces a by-name lookup.
type Verifier interface {
	VerifyDomain(ctx context.Context, domain string, providerDomainID int64) (*DomainRecords, error)
}

// Remover is an OPTIONAL registrar capability: withdraw the domain from the
// provider account. It is idempotent — a domain the account does not hold is
// already removed, so that returns nil rather than an error a retry would hit
// forever.
//
// providerDomainID follows GetDomain's contract: 0 forces a by-name lookup.
type Remover interface {
	RemoveDomain(ctx context.Context, domain string, providerDomainID int64) error
}

// seam is one app's registrar, its claim, and the server-token source its
// senders ask. It lives on the app: two apps in one process may hold
// different provider accounts, and one app's account token must never
// enroll another app's domain or sign another app's send.
type seam struct {
	mu      sync.RWMutex
	current Registrar
	// claimed records that a SUPERVISING composition installed the registrar.
	//
	// Tracked explicitly rather than inferred from current != unconfigured{},
	// for the reason syscfg documents: a supervisor whose config failed to
	// load still owns this operation, and the correct degraded state is "no
	// domain provisioning", never "the deployment uses its own credentials".
	claimed     bool
	tokenSource func(context.Context) (string, error)
}

var seamKey = appstate.NewKey[*seam]("maildomains.seam")

func seamFor(app core.App) *seam {
	return seamKey.GetOrInit(app, func() *seam {
		return &seam{current: unconfigured{}, tokenSource: noTokenSource}
	})
}

// noTokenSource is the default server-token source: it knows nothing.
func noTokenSource(context.Context) (string, error) { return "", ErrNotConfigured }

// unconfigured is the zero registrar: it performs nothing. It stands in before
// any Set* call so a read during boot returns an error rather than panicking.
type unconfigured struct{}

func (unconfigured) AddDomain(context.Context, string) (*DomainRecords, error) {
	return nil, ErrNotConfigured
}
func (unconfigured) GetDomain(context.Context, string, int64) (*DomainRecords, error) {
	return nil, ErrNotConfigured
}

// SetResolver points app's seam at the deployment's own registrar — the
// standalone shape, where the deployment legitimately holds its own account
// token.
//
// Ignored once a supervising composition has claimed app's seam. Core's wiring
// runs after a supervisor's, so without this the deployment would silently
// reclaim an operation its operator owns.
func SetResolver(app core.App, r Registrar) {
	if r == nil {
		return
	}
	s := seamFor(app)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed {
		return
	}
	s.current = r
}

// SetRegistrar installs app's registrar and CLAIMS app's seam. A supervising
// composition calls this BEFORE any package registers on app, so every
// consumer's first call already routes through it.
//
// A nil registrar is ignored rather than installed: it would turn every call
// into a nil dereference, and a caller passing nil has a bug, not an intent.
func SetRegistrar(app core.App, r Registrar) {
	if r == nil {
		return
	}
	s := seamFor(app)
	s.mu.Lock()
	s.current, s.claimed = r, true
	s.mu.Unlock()
}

// Current returns app's registrar. Never nil.
func Current(app core.App) Registrar {
	s := seamFor(app)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

// IsClaimed reports whether a supervising composition installed app's registrar.
func IsClaimed(app core.App) bool {
	s := seamFor(app)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.claimed
}
