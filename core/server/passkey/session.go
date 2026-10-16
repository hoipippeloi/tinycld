package passkey

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/golang-jwt/jwt/v5"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

var errBadSession = errors.New("passkey: ceremony expired or already used")

// ceremonyKind is part of the signing key, so a registration session never
// verifies as a login session or the reverse.
type ceremonyKind string

const (
	kindRegister ceremonyKind = "register"
	kindLogin    ceremonyKind = "login"
)

// sealSession hands the ceremony state to the client to bring back on finish,
// signed so the client cannot change it. Nothing is kept in memory between
// begin and finish, so a restart in between costs one retry, not a leak.
func sealSession(app core.App, kind ceremonyKind, data *webauthn.SessionData) (string, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	key, err := sessionKey(app, kind)
	if err != nil {
		return "", err
	}
	return security.NewJWT(jwt.MapClaims{
		"type":    "tinycld_passkey_" + string(kind),
		"session": base64.RawURLEncoding.EncodeToString(raw),
	}, key, ceremonyTimeout)
}

// openSession checks the token and spends its challenge. A challenge works
// once: a captured assertion cannot be replayed while the session is still
// within its timeout.
func openSession(app core.App, kind ceremonyKind, token string) (webauthn.SessionData, error) {
	var data webauthn.SessionData
	key, err := sessionKey(app, kind)
	if err != nil {
		return data, err
	}
	claims, err := security.ParseJWT(token, key)
	if err != nil {
		return data, errBadSession
	}
	encoded, _ := claims["session"].(string)
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || json.Unmarshal(raw, &data) != nil || data.Challenge == "" {
		return data, errBadSession
	}
	if !spentChallenges.spend(data.Challenge, data.Expires) {
		return data, errBadSession
	}
	return data, nil
}

func sessionKey(app core.App, kind ceremonyKind) (string, error) {
	users, err := app.FindCachedCollectionByNameOrId(usersCollection)
	if err != nil {
		return "", err
	}
	return users.AuthToken.Secret + ":tinycld_passkey_" + string(kind), nil
}

// challengeLedger remembers spent challenges until they would have expired
// anyway. It is per process, like the rate limiters: a second instance would
// keep its own ledger, and the ceremony timeout still bounds a replay there.
type challengeLedger struct {
	mu    sync.Mutex
	spent map[string]time.Time
}

var spentChallenges = &challengeLedger{spent: map[string]time.Time{}}

func (l *challengeLedger) spend(challenge string, expires time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for c, exp := range l.spent {
		if now.After(exp) {
			delete(l.spent, c)
		}
	}
	if _, used := l.spent[challenge]; used {
		return false
	}
	if expires.IsZero() {
		expires = now.Add(ceremonyTimeout)
	}
	l.spent[challenge] = expires
	return true
}
