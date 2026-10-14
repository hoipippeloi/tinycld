// Package passkey signs users in with WebAuthn passkeys, on its own or as the
// second step after a password, and lets them register and manage passkeys.
package passkey

import (
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/audit"
	"tinycld.org/core/authfactor"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("passkey")

// Register wires the passkey routes, and audits renames and removals made
// through the collection API.
func Register(app *pocketbase.PocketBase) {
	registerCore(app)
	audit.RegisterCollection(app, authfactor.PasskeysCollection, &audit.CollectionConfig{
		ExtractLabel: audit.LabelFromField("name"),
	})
}

func registerCore(app core.App) {
	registerRoutes(app)
	registerDeleteGuard(app)
}

// registerDeleteGuard refuses to remove an account's last factor through the
// collection API while the organization requires MFA. Without it, an account
// could drop to no factor at all, and the account password would work alone
// again. The authenticator app has the same floor in its disable route.
func registerDeleteGuard(app core.App) {
	app.OnRecordDeleteRequest(authfactor.PasskeysCollection).BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		user, err := e.App.FindRecordById(usersCollection, e.Record.GetString("user"))
		if err != nil {
			return e.Next()
		}
		if authfactor.RequiresEnrollment(e.App, user) && isLastFactor(e.App, user.Id) {
			return e.BadRequestError("Your organization requires two-step verification. Add another passkey or an authenticator app before you remove this one.", nil)
		}
		return e.Next()
	})
}

// isLastFactor reports whether the passkey being removed is the account's
// only factor: no confirmed authenticator app and no other passkey.
func isLastFactor(app core.App, userID string) bool {
	if totp, err := app.FindFirstRecordByFilter(authfactor.TOTPCollection,
		"user = {:user} && enabled_at != ''", map[string]any{"user": userID}); err == nil && totp != nil {
		return false
	}
	n, err := app.CountRecords(authfactor.PasskeysCollection, userFilter(userID))
	return err != nil || n <= 1
}
