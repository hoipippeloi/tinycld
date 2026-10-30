// Package nativeauth hands a browser sign-in to the native app.
//
// The native app runs passkey ceremonies in the system browser sheet, on the
// server's own web origin. iOS lets an app call the passkey API directly only
// for domains listed in the app's entitlements at build time, which cannot
// include a self-hosted server's domain; the browser sheet has no such limit.
//
// Flow, with PKCE so that another app that claims the tinycld:// scheme
// cannot use a code it intercepts:
//
//  1. The app makes a verifier and its S256 challenge and opens
//     /a/native-auth#code_challenge=... in the browser sheet. The parameters
//     go in the fragment, which the browser never sends to a server, so
//     tickets and enroll tokens do not reach access logs.
//  2. The page signs the user in (or, for registration, uses a ticket the app
//     got from POST /api/auth/native/ticket), then POSTs the challenge to
//     /api/auth/native/code with the new session and redirects to
//     tinycld://auth/callback?code=....
//  3. The app POSTs the code and verifier to /api/auth/native/exchange and
//     receives a normal auth response.
package nativeauth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"

	"tinycld.org/core/appstate"
	"tinycld.org/core/mfa"
	"tinycld.org/core/oauth"
	"tinycld.org/core/ratelimit"
)

const (
	usersCollection = "users"
	codeTTL         = 60 * time.Second
	ticketTTL       = 5 * time.Minute
	ticketType      = "tinycld_native_ticket"
)

var (
	errBadTicket = errors.New("nativeauth: invalid or expired ticket")
	// exchangeLimiter bounds code redemption per IP, per app. A code is
	// single use and lives 60 seconds; this only stops a client from
	// spinning on guesses.
	exchangeLimiter = ratelimit.NewPerApp("nativeauth.exchange", 20, time.Minute)
)

// Register wires the three handoff routes.
func Register(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/auth/native/ticket", func(re *core.RequestEvent) error {
			return handleTicket(re)
		})
		e.Router.POST("/api/auth/native/code", func(re *core.RequestEvent) error {
			return handleCode(re)
		})
		e.Router.POST("/api/auth/native/exchange", func(re *core.RequestEvent) error {
			return handleExchange(app, re)
		})
		return e.Next()
	})
}

func sessionUser(re *core.RequestEvent) (*core.Record, error) {
	if re.Auth == nil || re.Auth.Collection().Name != usersCollection {
		return nil, re.UnauthorizedError("Authentication required", nil)
	}
	return re.Auth, nil
}

// handleTicket gives the signed-in app a short-lived ticket to pass in the
// browser URL. The session token itself never goes in a URL: URLs end up in
// history and logs.
func handleTicket(re *core.RequestEvent) error {
	user, err := sessionUser(re)
	if err != nil {
		return err
	}
	ticket, err := security.NewJWT(jwt.MapClaims{
		"id":   user.Id,
		"type": ticketType,
		"jti":  security.RandomString(24),
	}, ticketKey(user), ticketTTL)
	if err != nil {
		return re.InternalServerError("Could not create a ticket", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"ticket": ticket})
}

// UserFromTicket returns the user a ticket was issued to, without spending
// it. The passkey registration's first step uses it; the last step spends the
// ticket with SpendTicket.
func UserFromTicket(app core.App, ticket string) (*core.Record, error) {
	user, _, err := verifyTicket(app, ticket)
	return user, err
}

// SpendTicket is UserFromTicket for the step that finishes the work the
// ticket allows. A ticket works for one registration only, so a copy taken
// from the browser sheet cannot add more passkeys later.
func SpendTicket(app core.App, ticket string) (*core.Record, error) {
	user, claims, err := verifyTicket(app, ticket)
	if err != nil {
		return nil, err
	}
	jti, _ := claims["jti"].(string)
	if jti == "" || !ticketsFor(app).spend(jti) {
		return nil, errBadTicket
	}
	return user, nil
}

func verifyTicket(app core.App, ticket string) (*core.Record, jwt.MapClaims, error) {
	unverified, err := security.ParseUnverifiedJWT(ticket)
	if err != nil {
		return nil, nil, errBadTicket
	}
	id, _ := unverified["id"].(string)
	if id == "" || unverified["type"] != ticketType {
		return nil, nil, errBadTicket
	}
	user, err := app.FindRecordById(usersCollection, id)
	if err != nil {
		return nil, nil, errBadTicket
	}
	claims, err := security.ParseJWT(ticket, ticketKey(user))
	if err != nil {
		return nil, nil, errBadTicket
	}
	return user, claims, nil
}

// ticketLedger remembers spent ticket ids for as long as a ticket can live.
// It lives on the app, in memory: a restart costs a user one retry, and a
// ticket id spent on one app says nothing about another app.
type ticketLedger struct {
	mu    sync.Mutex
	spent map[string]time.Time
}

var ticketsKey = appstate.NewKey[*ticketLedger]("nativeauth.spentTickets")

func ticketsFor(app core.App) *ticketLedger {
	return ticketsKey.GetOrInit(app, func() *ticketLedger {
		return &ticketLedger{spent: map[string]time.Time{}}
	})
}

func (l *ticketLedger) spend(jti string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for k, exp := range l.spent {
		if now.After(exp) {
			delete(l.spent, k)
		}
	}
	if _, used := l.spent[jti]; used {
		return false
	}
	l.spent[jti] = now.Add(ticketTTL)
	return true
}

func ticketKey(user *core.Record) string {
	return user.TokenKey() + user.Collection().AuthToken.Secret + ":" + ticketType
}

type codeRequest struct {
	CodeChallenge string `json:"codeChallenge"`
	Code          string `json:"code"`
	CodeVerifier  string `json:"codeVerifier"`
}

func handleCode(re *core.RequestEvent) error {
	user, err := sessionUser(re)
	if err != nil {
		return err
	}
	var req codeRequest
	if err := re.BindBody(&req); err != nil {
		return re.BadRequestError("Invalid request body", err)
	}
	if len(req.CodeChallenge) != 43 {
		return re.BadRequestError("codeChallenge must be an S256 challenge", nil)
	}
	code, err := codesFor(re.App).issue(user.Id, req.CodeChallenge)
	if err != nil {
		return re.InternalServerError("Could not create a code", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"code": code})
}

func handleExchange(app core.App, re *core.RequestEvent) error {
	if !exchangeLimiter.For(app).AllowOrLog(re.RealIP(), "nativeauth.exchange") {
		return re.Error(http.StatusTooManyRequests, "Too many attempts. Wait a minute and try again.", nil)
	}
	var req codeRequest
	if err := re.BindBody(&req); err != nil {
		return re.BadRequestError("Invalid request body", err)
	}
	entry, ok := codesFor(app).redeem(req.Code)
	if !ok || !oauth.VerifyPKCE(entry.challenge, req.CodeVerifier) {
		return re.BadRequestError("This sign-in link has expired. Try again.", nil)
	}
	user, err := app.FindRecordById(usersCollection, entry.userID)
	if err != nil {
		return re.BadRequestError("This sign-in link has expired. Try again.", err)
	}
	return apis.RecordAuthResponse(re, user, mfa.MethodHandoff, nil)
}

// codeStore keeps issued codes in memory for their 60 seconds. It lives on
// the app that issued them, so a code is redeemable only there: another app
// in the same process has no entry for it, even for a user with the same id.
// A restart in that window costs the user one retry.
type codeStore struct {
	mu      sync.Mutex
	entries map[string]codeEntry
}

type codeEntry struct {
	userID    string
	challenge string
	expires   time.Time
}

var codesKey = appstate.NewKey[*codeStore]("nativeauth.codes")

func codesFor(app core.App) *codeStore {
	return codesKey.GetOrInit(app, func() *codeStore {
		return &codeStore{entries: map[string]codeEntry{}}
	})
}

func (s *codeStore) issue(userID, challenge string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, e := range s.entries {
		if now.After(e.expires) {
			delete(s.entries, k)
		}
	}
	s.entries[code] = codeEntry{userID: userID, challenge: challenge, expires: now.Add(codeTTL)}
	return code, nil
}

// redeem returns and removes the entry; a code works once, even when the
// verifier is wrong, so a guess burns the code.
func (s *codeStore) redeem(code string) (codeEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[code]
	delete(s.entries, code)
	if !ok || time.Now().After(entry.expires) {
		return codeEntry{}, false
	}
	return entry, true
}
