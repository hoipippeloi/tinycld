package passkey

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/audit"
	"tinycld.org/core/authfactor"
	"tinycld.org/core/mfa"
	"tinycld.org/core/nativeauth"
	"tinycld.org/core/ratelimit"
)

const maxPasskeysPerUser = 20

// loginLimiter bounds passkey sign-in attempts per IP. A passkey cannot be
// guessed, so this only stops a client from making the server do signature
// checks without end.
var loginLimiter = ratelimit.New(30, time.Minute)

var errNoMatch = errors.New("passkey: no matching passkey")

type ceremonyRequest struct {
	SessionToken   string          `json:"sessionToken"`
	Credential     json.RawMessage `json:"credential"`
	Name           string          `json:"name"`
	MFAToken       string          `json:"mfaToken"`
	MFAEnrollToken string          `json:"mfaEnrollToken"`
	Ticket         string          `json:"ticket"`
}

func registerRoutes(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/account/passkeys/register/begin", func(re *core.RequestEvent) error {
			return handleRegisterBegin(app, re)
		})
		e.Router.POST("/api/account/passkeys/register/finish", func(re *core.RequestEvent) error {
			return handleRegisterFinish(app, re)
		})
		e.Router.POST("/api/auth/passkey/login/begin", func(re *core.RequestEvent) error {
			return handleLoginBegin(app, re)
		})
		e.Router.POST("/api/auth/passkey/login/finish", func(re *core.RequestEvent) error {
			return handleLoginFinish(app, re)
		})
		e.Router.POST("/api/auth/mfa/passkey/begin", func(re *core.RequestEvent) error {
			return handleSecondStepBegin(app, re)
		})
		e.Router.POST("/api/auth/mfa/passkey/finish", func(re *core.RequestEvent) error {
			return handleSecondStepFinish(app, re)
		})
		return e.Next()
	})
}

// readRequest uses BindBody so the body stays re-readable for
// apis.RecordAuthResponse.
func readRequest(re *core.RequestEvent) (ceremonyRequest, error) {
	var req ceremonyRequest
	if err := re.BindBody(&req); err != nil {
		return req, re.BadRequestError("Invalid request body", err)
	}
	return req, nil
}

// registrant is who may add a passkey: the signed-in user, a user finishing a
// required enrollment (enroll token), or the app handing a signed-in user to
// the browser to register there (native ticket).
func registrant(app core.App, re *core.RequestEvent, req ceremonyRequest, finishing bool) (*core.Record, bool, error) {
	switch {
	case req.MFAEnrollToken != "":
		user, err := mfa.UserFromEnrollToken(app, req.MFAEnrollToken)
		if err != nil {
			return nil, false, re.UnauthorizedError("This sign-in step has expired. Sign in again.", err)
		}
		return user, true, nil
	case req.Ticket != "":
		user, err := ticketUser(app, req.Ticket, finishing)
		if err != nil {
			return nil, false, re.UnauthorizedError("This link has expired. Start again from the app.", err)
		}
		return user, false, nil
	}
	if re.Auth == nil || re.Auth.Collection().Name != usersCollection {
		return nil, false, re.UnauthorizedError("Authentication required", nil)
	}
	return re.Auth, false, nil
}

// ticketUser checks a native ticket on the first step and spends it on the
// last, so one ticket registers one passkey.
func ticketUser(app core.App, ticket string, finishing bool) (*core.Record, error) {
	if finishing {
		return nativeauth.SpendTicket(app, ticket)
	}
	return nativeauth.UserFromTicket(app, ticket)
}

func handleRegisterBegin(app core.App, re *core.RequestEvent) error {
	req, err := readRequest(re)
	if err != nil {
		return err
	}
	user, _, err := registrant(app, re, req, false)
	if err != nil {
		return err
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	acc, err := loadAccount(app, user)
	if err != nil {
		return re.InternalServerError("Could not read passkeys", err)
	}
	if len(acc.creds) >= maxPasskeysPerUser {
		return re.BadRequestError("Too many passkeys. Remove one first.", nil)
	}

	creation, session, err := wa.BeginRegistration(acc,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(acc.descriptors()),
	)
	if err != nil {
		return re.InternalServerError("Could not start passkey setup", err)
	}
	token, err := sealSession(app, kindRegister, session)
	if err != nil {
		return re.InternalServerError("Could not start passkey setup", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"options": creation.Response, "sessionToken": token})
}

func handleRegisterFinish(app core.App, re *core.RequestEvent) error {
	req, err := readRequest(re)
	if err != nil {
		return err
	}
	user, viaEnroll, err := registrant(app, re, req, true)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 100 {
		return re.BadRequestError("name must be 1 to 100 characters", nil)
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	session, err := openSession(app, kindRegister, req.SessionToken)
	if err != nil || string(session.UserID) != user.Id {
		return re.BadRequestError("This passkey request expired. Try again.", nil)
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		return re.BadRequestError("The passkey response could not be read.", err)
	}
	acc, err := loadAccount(app, user)
	if err != nil {
		return re.InternalServerError("Could not read passkeys", err)
	}
	cred, err := wa.CreateCredential(acc, session, parsed)
	if err != nil {
		return re.BadRequestError("The passkey could not be verified.", err)
	}

	collection, err := app.FindCollectionByNameOrId(authfactor.PasskeysCollection)
	if err != nil {
		return re.InternalServerError("Passkeys are unavailable", err)
	}
	row := core.NewRecord(collection)
	row.Set("user", user.Id)
	row.Set("name", name)
	row.Set("credential_id", encodeID(cred.ID))
	row.Set("credential", cred)
	if err := app.Save(row); err != nil {
		return re.BadRequestError("Could not save the passkey. It may already be registered.", err)
	}
	if err := audit.Log(app, "passkey.added", authfactor.PasskeysCollection, row.Id, name, re, map[string]any{"user": user.Id}); err != nil {
		log.WarnContext(re.Request.Context(), "passkey audit write failed", "id", row.Id, "err", err)
	}

	if viaEnroll {
		return apis.RecordAuthResponse(re, user, mfa.MethodPasskey, nil)
	}
	return re.JSON(http.StatusOK, map[string]any{"record": row})
}

func handleLoginBegin(app core.App, re *core.RequestEvent) error {
	if !loginLimiter.AllowOrLog(re.RealIP(), "passkey.login") {
		return tooMany(re)
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	assertion, session, err := wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return re.InternalServerError("Could not start passkey sign-in", err)
	}
	token, err := sealSession(app, kindLogin, session)
	if err != nil {
		return re.InternalServerError("Could not start passkey sign-in", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"options": assertion.Response, "sessionToken": token})
}

// handleLoginFinish signs in with a passkey alone. User verification (PIN or
// biometric on the device) is required, so the passkey is already two
// factors and the sign-in gate lets it through.
func handleLoginFinish(app core.App, re *core.RequestEvent) error {
	if !loginLimiter.AllowOrLog(re.RealIP(), "passkey.login") {
		return tooMany(re)
	}
	req, err := readRequest(re)
	if err != nil {
		return err
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	session, err := openSession(app, kindLogin, req.SessionToken)
	if err != nil {
		return re.BadRequestError("This passkey request expired. Try again.", nil)
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		return re.BadRequestError("The passkey response could not be read.", err)
	}

	var acc *account
	_, cred, err := wa.ValidatePasskeyLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
		found, err := accountForCredential(app, rawID, userHandle)
		acc = found
		return found, err
	}, session, parsed)
	if err != nil || acc == nil {
		return re.BadRequestError("This passkey is not registered here.", err)
	}
	return finishSignIn(app, re, acc, cred)
}

func handleSecondStepBegin(app core.App, re *core.RequestEvent) error {
	req, err := readRequest(re)
	if err != nil {
		return err
	}
	user, err := mfa.UserFromVerifyToken(app, req.MFAToken)
	if err != nil {
		return re.UnauthorizedError("This sign-in step has expired. Sign in again.", err)
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	acc, err := loadAccount(app, user)
	if err != nil {
		return re.InternalServerError("Could not read passkeys", err)
	}
	if len(acc.creds) == 0 {
		return re.BadRequestError("This passkey is not registered here.", nil)
	}
	assertion, session, err := wa.BeginLogin(acc, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return re.InternalServerError("Could not start passkey sign-in", err)
	}
	token, err := sealSession(app, kindLogin, session)
	if err != nil {
		return re.InternalServerError("Could not start passkey sign-in", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"options": assertion.Response, "sessionToken": token})
}

func handleSecondStepFinish(app core.App, re *core.RequestEvent) error {
	req, err := readRequest(re)
	if err != nil {
		return err
	}
	user, err := mfa.UserFromVerifyToken(app, req.MFAToken)
	if err != nil {
		return re.UnauthorizedError("This sign-in step has expired. Sign in again.", err)
	}
	wa, err := relyingParty(app, re)
	if err != nil {
		return re.BadRequestError("Passkeys work only on this server's own web address.", err)
	}
	session, err := openSession(app, kindLogin, req.SessionToken)
	if err != nil || string(session.UserID) != user.Id {
		return re.BadRequestError("This passkey request expired. Try again.", nil)
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		return re.BadRequestError("The passkey response could not be read.", err)
	}
	acc, err := loadAccount(app, user)
	if err != nil {
		return re.InternalServerError("Could not read passkeys", err)
	}
	cred, err := wa.ValidateLogin(acc, session, parsed)
	if err != nil {
		return re.BadRequestError("The passkey could not be verified.", err)
	}
	return finishSignIn(app, re, acc, cred)
}

// finishSignIn refuses a credential whose sign count went backwards (a sign
// the authenticator may have been cloned), records the use and issues the
// session.
func finishSignIn(app core.App, re *core.RequestEvent, acc *account, cred *webauthn.Credential) error {
	if cred.Authenticator.CloneWarning {
		log.WarnContext(re.Request.Context(), "passkey sign count went backwards; refusing", "userID", acc.record.Id)
		return re.BadRequestError("This passkey could not be verified.", nil)
	}
	row := acc.rowFor(cred.ID)
	if row == nil {
		return re.BadRequestError("This passkey is not registered here.", nil)
	}
	if err := recordUse(app, row, cred); err != nil {
		log.WarnContext(re.Request.Context(), "could not record passkey use", "id", row.Id, "err", err)
	}
	return apis.RecordAuthResponse(re, acc.record, mfa.MethodPasskey, nil)
}

// accountForCredential resolves a discoverable login: the credential id must
// be registered, and to the account the authenticator names.
func accountForCredential(app core.App, rawID, userHandle []byte) (*account, error) {
	row, err := app.FindFirstRecordByFilter(authfactor.PasskeysCollection, "credential_id = {:id}",
		map[string]any{"id": encodeID(rawID)})
	if err != nil {
		return nil, errNoMatch
	}
	if row.GetString("user") != string(userHandle) {
		return nil, errNoMatch
	}
	user, err := app.FindRecordById(usersCollection, row.GetString("user"))
	if err != nil {
		return nil, errNoMatch
	}
	return loadAccount(app, user)
}

func tooMany(re *core.RequestEvent) error {
	return re.Error(http.StatusTooManyRequests, "Too many attempts. Wait a minute and try again.", nil)
}

func userFilter(userID string) dbx.Expression {
	return dbx.HashExp{"user": userID}
}
