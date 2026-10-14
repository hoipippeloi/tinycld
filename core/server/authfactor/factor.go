package authfactor

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("authfactor")

const (
	// TOTPCollection holds at most one authenticator-app enrollment per user.
	// A row with an empty enabled_at is a setup the user has not confirmed.
	TOTPCollection = "mfa_totp"
	// PasskeysCollection holds one row per registered WebAuthn credential.
	PasskeysCollection = "passkeys"
)

// HasSecondFactor reports whether userID has a confirmed authenticator app or
// at least one passkey. When it is true the account password alone no longer
// signs in: not through the login form, and not through a protocol client.
//
// A lookup error reports true. If we cannot prove the account has no factor,
// the safe answer is the one that refuses the password-only path.
func HasSecondFactor(app core.App, userID string) bool {
	if userID == "" {
		return false
	}
	totp, err := hasRow(app, TOTPCollection, "user = {:user} && enabled_at != ''", userID)
	if err != nil {
		log.Warn("second factor lookup failed", "collection", TOTPCollection, "userID", userID, "err", err)
		return true
	}
	if totp {
		return true
	}
	passkey, err := hasRow(app, PasskeysCollection, "user = {:user}", userID)
	if err != nil {
		log.Warn("second factor lookup failed", "collection", PasskeysCollection, "userID", userID, "err", err)
		return true
	}
	return passkey
}

func hasRow(app core.App, collection, filter, userID string) (bool, error) {
	_, err := app.FindFirstRecordByFilter(collection, filter, map[string]any{"user": userID})
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

// RequireMFAKey is the system_settings key an owner or admin sets to "true"
// to make every member enroll a second factor.
const RequireMFAKey = "auth.require_mfa"

// RequireMFA reports whether an owner or admin has made MFA mandatory.
//
// Read from the row on each call, not through syscfg: syscfg answers from a
// supervising provider when one is set, and this is the org's own policy.
func RequireMFA(app core.App) bool {
	row, err := app.FindFirstRecordByFilter("system_settings", "key = {:key}", map[string]any{"key": RequireMFAKey})
	if err != nil {
		return false
	}
	return row.GetString("value") == "true"
}

// guestRole is the role a share-link visitor's account carries. Guests are
// outside the organization's MFA requirement: they sign in with emailed codes.
const guestRole = "guest"

// PasswordOnlyAllowed reports whether user may sign in with a single factor
// (the account password, or an emailed code): only when the account has no
// second factor, and the organization does not require one of this user.
// Every single-factor path (protocol logins, emailed codes, the sign-in gate)
// asks this one question, so they cannot drift apart.
func PasswordOnlyAllowed(app core.App, user *core.Record) bool {
	if HasSecondFactor(app, user.Id) {
		return false
	}
	return !RequiresEnrollment(app, user)
}

// RequiresEnrollment reports whether the organization requires a second
// factor of user (every account except guests) while MFA is required.
func RequiresEnrollment(app core.App, user *core.Record) bool {
	return user.GetString("role") != guestRole && RequireMFA(app)
}
