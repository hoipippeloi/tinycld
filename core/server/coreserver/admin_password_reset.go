package coreserver

import (
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/audit"
	"tinycld.org/core/ratelimit"
)

// adminResetLimiter bounds reset emails per admin. Each one mails a live
// credential, so a script with an admin session must not turn it into a
// mail cannon.
var adminResetLimiter = ratelimit.New(20, time.Hour)

type adminPasswordResetRequest struct {
	// Email is where the link goes; empty means the member's own email.
	Email string `json:"email"`
}

// RegisterAdminPasswordReset wires POST /api/admin/users/{id}/password-reset/send.
//
// PocketBase's own requestPasswordReset mails only the account's address. A
// member who lost their password has often lost that mailbox too, so an owner
// or admin can send the link to another address they confirmed with the
// member. This is an action that sends mail (the same shape as the invite
// link's send), not a data write: the member's record changes only when they
// use the link.
func RegisterAdminPasswordReset(app *pocketbase.PocketBase) {
	registerAdminPasswordResetCore(app)
}

func registerAdminPasswordResetCore(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/admin/users/{id}/password-reset/send", func(re *core.RequestEvent) error {
			return handleAdminPasswordReset(app, re)
		}).BindFunc(requireAuthCore)
		return e.Next()
	})
}

func handleAdminPasswordReset(app core.App, re *core.RequestEvent) error {
	caller := re.Auth
	if caller.Collection().Name != "users" || caller.GetBool("disabled") || !isOrgAdmin(caller) {
		return re.ForbiddenError("Only an owner or admin can send a reset link", nil)
	}
	target, err := app.FindRecordById("users", re.Request.PathValue("id"))
	if err != nil {
		return re.NotFoundError("User not found", err)
	}
	if target.Id == caller.Id {
		return re.BadRequestError("Use Settings → Security to change your own password.", nil)
	}
	if target.GetString("role") == "owner" && caller.GetString("role") != "owner" {
		return re.ForbiddenError("Only an owner can reset another owner's password", nil)
	}

	var req adminPasswordResetRequest
	if err := re.BindBody(&req); err != nil {
		return re.BadRequestError("Invalid request body", err)
	}
	to := strings.TrimSpace(req.Email)
	if to == "" {
		to = target.Email()
	}
	addr, err := mail.ParseAddress(to)
	if err != nil || addr.Address == "" {
		return re.BadRequestError("Enter a valid email address", err)
	}
	if !adminResetLimiter.AllowOrLog(caller.Id, "admin.password_reset") {
		return re.Error(http.StatusTooManyRequests, "Too many reset emails. Try again later.", nil)
	}

	token, err := target.NewPasswordResetToken()
	if err != nil {
		return re.InternalServerError("Could not create a reset link", err)
	}
	settings := app.Settings().Meta
	name := target.GetString("name")
	subject, htmlBody, text := buildPasswordResetMessage(settings.AppURL, settings.AppName, name, token)
	if err := sendContext(re.Request.Context(), app, name, addr.Address, subject, htmlBody, text); err != nil {
		return re.InternalServerError("Could not send the email", err)
	}

	sentTo := "own email"
	if !strings.EqualFold(addr.Address, target.Email()) {
		sentTo = addr.Address
	}
	if err := audit.Log(app, "password.reset_sent", "users", target.Id, target.Email(), re, map[string]any{"sentTo": sentTo}); err != nil {
		srvLog.WarnContext(re.Request.Context(), "admin password reset audit write failed", "userID", target.Id, "err", err)
	}
	return re.JSON(http.StatusOK, map[string]any{"sentTo": addr.Address})
}
