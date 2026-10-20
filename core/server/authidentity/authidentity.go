// Package authidentity finds the person an address belongs to, so a person
// can sign in with an address the deployment hosts.
//
// A person signs in with their username or with a hosted address. The
// account email is not a sign-in name: the deployment does not own that
// address, and the person may change it to anything. It stays the address
// that invites and password resets go to.
//
// Core hosts no addresses. A package that does registers a Resolver from its
// Register(app); the password sign-in (web and native) and every protocol
// login (davauth) ask the registry.
package authidentity

import (
	"slices"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("authidentity")

// Resolver returns the users record that owns address, or nil when address
// is not one the package hosts. An error means the lookup itself failed.
type Resolver func(app core.App, address string) (*core.Record, error)

var (
	mu        sync.RWMutex
	resolvers = map[string]Resolver{}
)

// RegisterResolver records the resolver of the package named name.
// Re-registering a name replaces its resolver.
func RegisterResolver(name string, r Resolver) {
	mu.Lock()
	defer mu.Unlock()
	resolvers[name] = r
}

// Resolve returns the users record that owns identifier when identifier is an
// address a registered package hosts, and nil otherwise. Resolvers run in
// name order, so the answer does not depend on registration order.
func Resolve(app core.App, identifier string) (*core.Record, error) {
	if !strings.Contains(identifier, "@") {
		return nil, nil
	}
	mu.RLock()
	names := make([]string, 0, len(resolvers))
	for name := range resolvers {
		names = append(names, name)
	}
	slices.Sort(names)
	ordered := make([]Resolver, len(names))
	for i, name := range names {
		ordered[i] = resolvers[name]
	}
	mu.RUnlock()

	for _, resolve := range ordered {
		record, err := resolve(app, identifier)
		if err != nil {
			return nil, err
		}
		if record != nil {
			return record, nil
		}
	}
	return nil, nil
}

// Register lets the password sign-in accept a hosted address. PocketBase
// looks the identity up by username only (the users identityFields); when that
// finds no one, a registered package may own the address. It must be bound
// before any hook that inspects e.Record, such as the disabled-account guard.
func Register(app core.App) {
	app.OnRecordAuthWithPasswordRequest("users").BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		// An explicit identityField asks for that field only.
		if e.Record != nil || e.IdentityField != "" {
			return e.Next()
		}
		record, err := Resolve(e.App, e.Identity)
		if err != nil {
			// PocketBase answers a missing record with its usual failure, so
			// a lookup error looks to the client like a wrong password.
			log.ErrorContext(e.Request.Context(), "sign-in address lookup failed", "err", err)
		}
		e.Record = record
		return e.Next()
	})
}

// ResetForTest clears the registry. Only tests call it.
func ResetForTest() {
	mu.Lock()
	defer mu.Unlock()
	resolvers = map[string]Resolver{}
}
