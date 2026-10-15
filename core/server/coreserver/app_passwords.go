package coreserver

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/audit"
	"tinycld.org/core/authfactor"
)

// maxAppPasswordsPerUser bounds how many rows one account can create. Nobody
// has this many devices; the cap stops a script from filling the table.
const maxAppPasswordsPerUser = 50

const maxAppPasswordNameLength = 100

type appPasswordCreateRequest struct {
	Name string `json:"name"`
}

// RegisterAppPasswords wires POST /api/account/app-passwords. Listing and
// revoking go through the collection's own rules; only creation is a route,
// because the plaintext is generated here and returned once.
func RegisterAppPasswords(app *pocketbase.PocketBase) {
	registerAppPasswordsCore(app)
	audit.RegisterCollection(app, authfactor.AppPasswordsCollection, &audit.CollectionConfig{
		ExtractLabel: audit.LabelFromField("name"),
	})
}

func registerAppPasswordsCore(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/account/app-passwords", func(re *core.RequestEvent) error {
			return handleAppPasswordCreate(app, re)
		}).BindFunc(requireAuthCore)
		return e.Next()
	})

	// A new tokenKey is how PocketBase ends every session: a password change,
	// "sign out everywhere", a disabled account. App passwords end with them,
	// in the same transaction, so access made from an old session goes too.
	app.OnRecordUpdate("users").BindFunc(func(e *core.RecordEvent) error {
		before := e.Record.Original().TokenKey()
		if err := e.Next(); err != nil {
			return err
		}
		if e.Record.TokenKey() == before {
			return nil
		}
		return authfactor.RevokeAppPasswords(e.App, e.Record.Id)
	})
}

func handleAppPasswordCreate(app core.App, re *core.RequestEvent) error {
	user, err := requireSelfUser(re)
	if err != nil {
		return err
	}

	var req appPasswordCreateRequest
	if err := json.NewDecoder(re.Request.Body).Decode(&req); err != nil {
		return re.BadRequestError("Invalid request body", err)
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > maxAppPasswordNameLength {
		return re.BadRequestError("name must be 1 to 100 characters", nil)
	}

	count, err := app.CountRecords(authfactor.AppPasswordsCollection, dbx.HashExp{"user": user.Id})
	if err != nil {
		return re.InternalServerError("could not count app passwords", err)
	}
	if count >= maxAppPasswordsPerUser {
		return re.BadRequestError("too many app passwords; revoke one first", nil)
	}

	collection, err := app.FindCollectionByNameOrId(authfactor.AppPasswordsCollection)
	if err != nil {
		return re.InternalServerError("app passwords are unavailable", err)
	}
	display, hash, err := authfactor.GenerateAppPassword()
	if err != nil {
		return re.InternalServerError("could not generate an app password", err)
	}
	row := core.NewRecord(collection)
	row.Set("user", user.Id)
	row.Set("name", name)
	row.Set("hash", hash)
	if err := app.Save(row); err != nil {
		return re.InternalServerError("could not save the app password", err)
	}

	if err := audit.Log(app, "created", authfactor.AppPasswordsCollection, row.Id, name, re, nil); err != nil {
		srvLog.WarnContext(re.Request.Context(), "app password audit write failed", "id", row.Id, "err", err)
	}

	return re.JSON(http.StatusOK, map[string]any{
		"record":   row,
		"password": display,
	})
}
