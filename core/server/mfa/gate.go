package mfa

import (
	"net/http"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/authfactor"
)

// Auth methods this package passes to apis.RecordAuthResponse. The gate lets
// them through because each one IS the second step.
const (
	MethodTOTP     = "totp"
	MethodRecovery = "recovery"
	MethodPasskey  = "passkey"
	// MethodHandoff: a browser session that already passed the gate, handed
	// to the native app (see the nativeauth package).
	MethodHandoff = "handoff"
)

const (
	usersCollection = "users"
	settingsTable   = "system_settings"
	// RequireMFAKey is re-exported so callers that already import mfa need
	// not import authfactor for it.
	RequireMFAKey = authfactor.RequireMFAKey
)

// registerGate binds the second-step check onto every users sign-in.
//
// OnRecordAuthRequest is the tail every sign-in path shares (password, OTP,
// OAuth2, and this package's own verify routes), so one hook covers them all.
// PocketBase's built-in MFA stays off: it can only pair two of its own methods
// (password, OTP, OAuth2) and has no authenticator app or passkey.
func registerGate(app core.App) {
	app.OnRecordAuthRequest(usersCollection).BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if e.Record == nil {
			return e.Next()
		}
		if !passesGate(e.AuthMethod) {
			if authfactor.HasSecondFactor(e.App, e.Record.Id) {
				return writePending(e, purposeVerify, map[string]any{"methods": availableMethods(e.App, e.Record.Id)})
			}
			if authfactor.RequiresEnrollment(e.App, e.Record) {
				return writePending(e, purposeEnroll, nil)
			}
		}
		// Last, after the second step: a temporary password must not let its
		// holder change the password before they prove the second factor.
		if e.AuthMethod != "" && authfactor.MustChangePassword(e.Record) {
			return writePasswordChange(e)
		}
		return e.Next()
	})
}

// registerPasswordResetHook ends a temporary password when the member sets
// their own through a reset token (the step writePasswordChange starts, or an
// emailed link).
func registerPasswordResetHook(app core.App) {
	app.OnRecordConfirmPasswordResetRequest(usersCollection).BindFunc(func(e *core.RecordConfirmPasswordResetRequestEvent) error {
		e.Record.Set(authfactor.MustChangePasswordField, false)
		return e.Next()
	})
}

// writePasswordChange answers a sign-in with an admin-set temporary password:
// no session, only a PocketBase password-reset token. The client sends it to
// the standard confirm-password-reset route with the member's new password,
// then signs in again. The token is bound to the account's token key, so it
// works once.
func writePasswordChange(e *core.RecordAuthRequestEvent) error {
	token, err := e.Record.NewPasswordResetToken()
	if err != nil {
		return e.InternalServerError("Could not start the password change.", err)
	}
	body := map[string]any{"passwordResetToken": token}
	// A required enrollment that ends here still carries its one-time
	// recovery codes; the client shows them before the password step.
	if e.Meta != nil {
		body["meta"] = e.Meta
	}
	if err := e.JSON(http.StatusUnauthorized, body); err != nil {
		return err
	}
	return apis.ErrMFA
}

// passesGate: an empty method is a token refresh (the session already passed
// the gate when it was issued), and the rest are second steps.
func passesGate(method string) bool {
	switch method {
	case "", MethodTOTP, MethodRecovery, MethodPasskey, MethodHandoff:
		return true
	}
	return false
}

// writePending answers the first step with a 401 that carries the pending
// token instead of a session. It returns apis.ErrMFA as PocketBase's own MFA
// does, so middleware treats the sign-in as incomplete.
func writePending(e *core.RecordAuthRequestEvent, p purpose, extra map[string]any) error {
	token, err := mintPending(e.Record, p)
	if err != nil {
		return e.InternalServerError("Could not start the second sign-in step.", err)
	}
	body := map[string]any{}
	for k, v := range extra {
		body[k] = v
	}
	if p == purposeEnroll {
		body["mfaEnrollToken"] = token
	} else {
		body["mfaToken"] = token
	}
	if err := e.JSON(http.StatusUnauthorized, body); err != nil {
		return err
	}
	return apis.ErrMFA
}

// availableMethods lists the second steps this account can complete, so the
// client offers only those.
func availableMethods(app core.App, userID string) []string {
	var methods []string
	if row, err := findTOTP(app, userID); err == nil && isConfirmed(row) {
		methods = append(methods, MethodTOTP)
		if row.GetInt("recovery_remaining") > 0 {
			methods = append(methods, MethodRecovery)
		}
	}
	if n, err := app.CountRecords(authfactor.PasskeysCollection, userFilter(userID)); err == nil && n > 0 {
		methods = append(methods, MethodPasskey)
	}
	return methods
}

// RequireMFA reports whether an owner or admin has made MFA mandatory.
func RequireMFA(app core.App) bool {
	return authfactor.RequireMFA(app)
}
