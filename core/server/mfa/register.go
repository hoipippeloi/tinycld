// Package mfa is the second sign-in step: an authenticator app (TOTP) with
// recovery codes, the sign-in gate that asks for it, and the owner/admin
// policy that makes it mandatory. Passkeys register as a factor through the
// passkey package and complete the same gate.
package mfa

import (
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/logging"
)

var log = logging.ForPackage("mfa")

// Register wires the sign-in gate and the MFA routes. It takes core.App so
// the passkey and nativeauth tests can bind the real gate onto a test app.
func Register(app core.App) {
	registerGate(app)
	registerPasswordResetHook(app)
	registerRoutes(app)
}
