package mfa

import (
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"tinycld.org/core/audit"
	"tinycld.org/core/authfactor"
	"tinycld.org/core/ratelimit"
)

// codeLimiter bounds code guesses per account, across every route that takes
// a code. Keyed by user, not IP or pending token: whoever holds the password
// can mint new pending tokens at will, so only the account is a stable key.
// Ten tries in 15 minutes leaves a six-digit code about a 1-in-30,000 chance
// per window. The budget is per app: a user id is unique only in its app.
var codeLimiter = ratelimit.NewPerApp("mfa.code", 10, 15*time.Minute)

type codeRequest struct {
	Code           string `json:"code"`
	RecoveryCode   string `json:"recoveryCode"`
	MFAToken       string `json:"mfaToken"`
	MFAEnrollToken string `json:"mfaEnrollToken"`
}

func registerRoutes(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/account/mfa/totp/begin", func(re *core.RequestEvent) error {
			return handleTOTPBegin(app, re)
		})
		e.Router.POST("/api/account/mfa/totp/confirm", func(re *core.RequestEvent) error {
			return handleTOTPConfirm(app, re)
		})
		e.Router.POST("/api/account/mfa/totp/disable", func(re *core.RequestEvent) error {
			return handleTOTPDisable(app, re)
		})
		e.Router.POST("/api/account/mfa/recovery/regenerate", func(re *core.RequestEvent) error {
			return handleRecoveryRegenerate(app, re)
		})
		e.Router.POST("/api/auth/mfa/verify", func(re *core.RequestEvent) error {
			return handleVerify(app, re)
		})
		return e.Next()
	})
}

// readCodeRequest uses BindBody, not a json.Decoder: BindBody leaves the body
// re-readable, and apis.RecordAuthResponse reads it again for RequestInfo.
func readCodeRequest(re *core.RequestEvent) (codeRequest, error) {
	var req codeRequest
	if err := re.BindBody(&req); err != nil {
		return req, re.BadRequestError("Invalid request body", err)
	}
	req.Code = strings.TrimSpace(req.Code)
	return req, nil
}

// sessionUser returns the signed-in users record. Superusers and other auth
// collections are refused: these routes act on the caller's own account.
func sessionUser(re *core.RequestEvent) (*core.Record, error) {
	if re.Auth == nil || re.Auth.Collection().Name != usersCollection {
		return nil, re.UnauthorizedError("Authentication required", nil)
	}
	return re.Auth, nil
}

// enrollingUser accepts either a session or the enroll token the sign-in gate
// hands out when MFA is required and the account has no factor yet. The
// second case is the only way to reach these routes without a session.
func enrollingUser(app core.App, re *core.RequestEvent, req codeRequest) (*core.Record, bool, error) {
	if req.MFAEnrollToken != "" {
		user, err := verifyPending(app, req.MFAEnrollToken, purposeEnroll)
		if err != nil {
			return nil, false, re.UnauthorizedError("This sign-in step has expired. Sign in again.", err)
		}
		return user, true, nil
	}
	user, err := sessionUser(re)
	return user, false, err
}

func handleTOTPBegin(app core.App, re *core.RequestEvent) error {
	req, err := readCodeRequest(re)
	if err != nil {
		return err
	}
	user, _, err := enrollingUser(app, re, req)
	if err != nil {
		return err
	}

	row, err := findTOTP(app, user.Id)
	switch {
	case err == nil && isConfirmed(row):
		return re.BadRequestError(msgAlreadyOn, nil)
	case err != nil:
		collection, cerr := app.FindCollectionByNameOrId(authfactor.TOTPCollection)
		if cerr != nil {
			return re.InternalServerError("MFA is unavailable", cerr)
		}
		row = core.NewRecord(collection)
		row.Set("user", user.Id)
	}

	key, err := newTOTPKey(issuerFor(re), user.GetString("email"))
	if err != nil {
		return re.InternalServerError("Could not create a secret", err)
	}
	row.Set("secret", key.Secret())
	row.Set("last_step", 0)
	setRecoveryCodes(row, nil)
	if err := app.Save(row); err != nil {
		return re.InternalServerError("Could not save the setup", err)
	}

	return re.JSON(http.StatusOK, map[string]any{
		"record": row,
		"secret": key.Secret(),
		"uri":    key.URL(),
	})
}

func handleTOTPConfirm(app core.App, re *core.RequestEvent) error {
	req, err := readCodeRequest(re)
	if err != nil {
		return err
	}
	user, viaEnroll, err := enrollingUser(app, re, req)
	if err != nil {
		return err
	}
	if !allowCode(re, user) {
		return tooManyAttempts(re)
	}

	row, err := findTOTP(app, user.Id)
	if err != nil {
		return re.BadRequestError(msgNoTOTP, nil)
	}
	if isConfirmed(row) {
		return re.BadRequestError(msgAlreadyOn, nil)
	}
	if err := checkTOTP(app, row, req.Code, time.Now()); err != nil {
		return re.BadRequestError(msgBadCode, nil)
	}

	codes, hashes, err := newRecoveryCodes()
	if err != nil {
		return re.InternalServerError("Could not create recovery codes", err)
	}
	setRecoveryCodes(row, hashes)
	row.Set("enabled_at", types.NowDateTime())
	if err := app.Save(row); err != nil {
		return re.InternalServerError("Could not enable MFA", err)
	}
	logAudit(app, re, "mfa.enabled", user, nil)

	if viaEnroll {
		// The required enrollment is the second step: finish the sign-in.
		return apis.RecordAuthResponse(re, user, MethodTOTP, map[string]any{"recoveryCodes": codes})
	}
	return re.JSON(http.StatusOK, map[string]any{"record": row, "recoveryCodes": codes})
}

func handleTOTPDisable(app core.App, re *core.RequestEvent) error {
	req, err := readCodeRequest(re)
	if err != nil {
		return err
	}
	user, err := sessionUser(re)
	if err != nil {
		return err
	}
	if !allowCode(re, user) {
		return tooManyAttempts(re)
	}
	row, err := findTOTP(app, user.Id)
	if err != nil {
		return re.BadRequestError(msgNoTOTP, nil)
	}
	if isConfirmed(row) {
		if err := proveFactor(app, row, req); err != nil {
			return re.BadRequestError(msgBadCode, nil)
		}
		if RequireMFA(app) && !hasPasskey(app, user.Id) {
			return re.BadRequestError("Your organization requires MFA. Add a passkey before you turn off the authenticator app.", nil)
		}
	}
	if err := app.Delete(row); err != nil {
		return re.InternalServerError("Could not turn off MFA", err)
	}
	if isConfirmed(row) {
		logAudit(app, re, "mfa.disabled", user, nil)
	}
	return re.JSON(http.StatusOK, map[string]any{"id": row.Id})
}

func handleRecoveryRegenerate(app core.App, re *core.RequestEvent) error {
	req, err := readCodeRequest(re)
	if err != nil {
		return err
	}
	user, err := sessionUser(re)
	if err != nil {
		return err
	}
	if !allowCode(re, user) {
		return tooManyAttempts(re)
	}
	row, err := findTOTP(app, user.Id)
	if err != nil || !isConfirmed(row) {
		return re.BadRequestError(msgNotConfirmed, nil)
	}
	if err := checkTOTP(app, row, req.Code, time.Now()); err != nil {
		return re.BadRequestError(msgBadCode, nil)
	}
	codes, hashes, err := newRecoveryCodes()
	if err != nil {
		return re.InternalServerError("Could not create recovery codes", err)
	}
	setRecoveryCodes(row, hashes)
	if err := app.Save(row); err != nil {
		return re.InternalServerError("Could not save recovery codes", err)
	}
	logAudit(app, re, "mfa.recovery_regenerated", user, nil)
	return re.JSON(http.StatusOK, map[string]any{"record": row, "recoveryCodes": codes})
}

// handleVerify completes a password sign-in with an authenticator code or a
// recovery code. The response is a normal PocketBase auth response.
func handleVerify(app core.App, re *core.RequestEvent) error {
	req, err := readCodeRequest(re)
	if err != nil {
		return err
	}
	user, err := verifyPending(app, req.MFAToken, purposeVerify)
	if err != nil {
		return re.UnauthorizedError("This sign-in step has expired. Sign in again.", err)
	}
	if !allowCode(re, user) {
		return tooManyAttempts(re)
	}
	row, err := findTOTP(app, user.Id)
	if err != nil || !isConfirmed(row) {
		return re.BadRequestError(msgBadCode, nil)
	}

	if req.RecoveryCode != "" {
		if err := consumeRecoveryCode(app, row, req.RecoveryCode); err != nil {
			return re.BadRequestError(msgBadCode, nil)
		}
		logAudit(app, re, "mfa.recovery_used", user, map[string]any{"remaining": row.GetInt("recovery_remaining")})
		return apis.RecordAuthResponse(re, user, MethodRecovery, nil)
	}
	if err := checkTOTP(app, row, req.Code, time.Now()); err != nil {
		return re.BadRequestError(msgBadCode, nil)
	}
	return apis.RecordAuthResponse(re, user, MethodTOTP, nil)
}

// proveFactor accepts an authenticator code or a recovery code.
func proveFactor(app core.App, row *core.Record, req codeRequest) error {
	if req.RecoveryCode != "" {
		return consumeRecoveryCode(app, row, req.RecoveryCode)
	}
	return checkTOTP(app, row, req.Code, time.Now())
}

func hasPasskey(app core.App, userID string) bool {
	n, err := app.CountRecords(authfactor.PasskeysCollection, userFilter(userID))
	return err == nil && n > 0
}

func allowCode(re *core.RequestEvent, user *core.Record) bool {
	if codeLimiter.For(re.App).Allow(user.Id) {
		return true
	}
	log.WarnContext(re.Request.Context(), "mfa code attempts rate limited", "userID", user.Id)
	return false
}

func tooManyAttempts(re *core.RequestEvent) error {
	return re.Error(http.StatusTooManyRequests, "Too many attempts. Wait a few minutes and try again.", nil)
}

func logAudit(app core.App, re *core.RequestEvent, action string, user *core.Record, metadata map[string]any) {
	if err := audit.Log(app, action, usersCollection, user.Id, user.GetString("email"), re, metadata); err != nil {
		log.WarnContext(re.Request.Context(), "mfa audit write failed", "action", action, "userID", user.Id, "err", err)
	}
}

// issuerFor names the server in the authenticator app: the host the user
// signed in to, without a port.
func issuerFor(re *core.RequestEvent) string {
	host := re.Request.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "" {
		return "TinyCld"
	}
	return host
}

func userFilter(userID string) dbx.Expression {
	return dbx.HashExp{"user": userID}
}
