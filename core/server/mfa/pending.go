package mfa

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"

	"tinycld.org/core/authfactor"
)

// purpose names what a pending token lets its holder do. It is part of the
// signing key, so a token minted for one purpose never verifies for another.
type purpose string

const (
	// purposeVerify: the password was right, now prove the second factor.
	purposeVerify purpose = "tinycld_mfa_verify"
	// purposeEnroll: the password was right, MFA is required and the account
	// has no factor yet, so the holder may enroll one and nothing else.
	purposeEnroll purpose = "tinycld_mfa_enroll"
)

const (
	verifyTokenTTL = 5 * time.Minute
	enrollTokenTTL = 15 * time.Minute
)

var errInvalidPending = errors.New("mfa: invalid or expired sign-in step")

// mintPending returns a short-lived token that names the user who passed the
// first sign-in step.
//
// It is NOT a session. PocketBase accepts only tokens with type "auth" signed
// with the user's auth key; this one carries another type and a key with the
// purpose appended, so it cannot stand in for a session anywhere. The user's
// tokenKey is part of the key (as it is for real sessions), so "sign out
// everywhere" and a password change also void every pending step.
func mintPending(user *core.Record, p purpose) (string, error) {
	ttl := verifyTokenTTL
	if p == purposeEnroll {
		ttl = enrollTokenTTL
	}
	return security.NewJWT(jwt.MapClaims{
		"id":           user.Id,
		"collectionId": user.Collection().Id,
		"type":         string(p),
	}, pendingKey(user, p), ttl)
}

// verifyPending returns the user a pending token was minted for.
func verifyPending(app core.App, token string, p purpose) (*core.Record, error) {
	unverified, err := security.ParseUnverifiedJWT(token)
	if err != nil {
		return nil, errInvalidPending
	}
	id, _ := unverified["id"].(string)
	if id == "" || unverified["type"] != string(p) {
		return nil, errInvalidPending
	}
	user, err := app.FindRecordById(usersCollection, id)
	if err != nil {
		return nil, errInvalidPending
	}
	if _, err := security.ParseJWT(token, pendingKey(user, p)); err != nil {
		return nil, errInvalidPending
	}
	// An enroll token is for an account with no factor. Once one exists, the
	// enrollment is done and the token must not add another factor (or mint a
	// session) for whoever else may have seen it.
	if p == purposeEnroll && authfactor.HasSecondFactor(app, user.Id) {
		return nil, errInvalidPending
	}
	return user, nil
}

func pendingKey(user *core.Record, p purpose) string {
	return user.TokenKey() + user.Collection().AuthToken.Secret + ":" + string(p)
}

// UserFromVerifyToken returns the user a "prove your second factor" token was
// minted for. The passkey package uses it to accept a passkey as that step.
func UserFromVerifyToken(app core.App, token string) (*core.Record, error) {
	return verifyPending(app, token, purposeVerify)
}

// UserFromEnrollToken returns the user an enroll token was minted for. The
// passkey package uses it so that a required enrollment can be a passkey.
func UserFromEnrollToken(app core.App, token string) (*core.Record, error) {
	return verifyPending(app, token, purposeEnroll)
}
