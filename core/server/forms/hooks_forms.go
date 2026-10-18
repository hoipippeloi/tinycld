package forms

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/pocketbase/dbx"
	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
)

const formsCollection = "forms"

type ctxKey struct{}

// settlingKey marks a save that clears a sibling's default flag, so the
// update hook does not refuse it as "unsetting the only default".
var settlingKey = ctxKey{}

func fieldErr(field, code, msg string) validation.Errors {
	return validation.Errors{field: validation.NewError(code, msg)}
}

func isSettling(ctx context.Context) bool {
	return ctx != nil && ctx.Value(settlingKey) == true
}

func bindFormsHooks(app core.App, defs *Defs) {
	validate := func(e *core.RecordEvent) error {
		host := defs.Host(e.Record.GetString("host"))
		if host == nil {
			return fieldErr("host", "validation_unknown_host", "No installed package provides this form host.")
		}
		if e.Record.GetBool("is_default") && e.Record.GetBool("archived") {
			return fieldErr("archived", "validation_default_unarchivable", "The default form cannot be archived. Make another form the default first.")
		}
		def, err := ParseDefinition([]byte(e.Record.GetString("definition")))
		if err != nil {
			return fieldErr("definition", invalidDefinition, "The definition is not valid JSON.")
		}
		if errs := ValidateDefinition(def, host); errs != nil {
			return errs
		}
		return nil
	}
	// The save and the clearing of the siblings' default flag commit together,
	// so a failed clear never leaves two defaults or a half-saved form.
	saveAndSettle := func(e *core.RecordEvent) error {
		return e.App.RunInTransaction(func(txApp core.App) error {
			e.App = txApp
			if err := e.Next(); err != nil {
				return err
			}
			return settleDefault(e.Context, txApp, e.Record)
		})
	}
	app.OnRecordCreate(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		if err := validate(e); err != nil {
			return err
		}
		return saveAndSettle(e)
	})
	app.OnRecordUpdate(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		// A settling save only clears is_default on a sibling; the sibling's
		// definition is not what changed, so it is not revalidated here.
		if isSettling(e.Context) {
			return e.Next()
		}
		// Read the stored row: a record saved earlier in this process keeps
		// its first-load state in Original().
		orig, err := e.App.FindRecordById(formsCollection, e.Record.Id)
		if err != nil {
			return err
		}
		if orig.GetString("host") != e.Record.GetString("host") {
			return fieldErr("host", "validation_host_immutable", "A form cannot move to another record type.")
		}
		if err := validate(e); err != nil {
			return err
		}
		if orig.GetBool("is_default") && !e.Record.GetBool("is_default") {
			return fieldErr("is_default", "validation_default_required", "Set another form as the default first.")
		}
		return saveAndSettle(e)
	})
	app.OnRecordDelete(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetBool("is_default") {
			return fieldErr("id", "validation_default_undeletable", "The default form cannot be deleted. Make another form the default first.")
		}
		host := defs.Host(e.Record.GetString("host"))
		if host != nil {
			_, colErr := e.App.FindCollectionByNameOrId(host.Collection)
			if colErr != nil && !errors.Is(colErr, sql.ErrNoRows) {
				return fmt.Errorf("forms: check form use: %w", colErr)
			}
			if colErr != nil {
				log.DebugContext(e.Context, "host collection absent, skipping in-use check", "collection", host.Collection)
			} else {
				_, err := e.App.FindFirstRecordByFilter(host.Collection, host.FormColumn+" = {:id}", dbx.Params{"id": e.Record.Id})
				if err == nil {
					return fieldErr("id", "validation_form_in_use", "This form is in use. Archive it instead.")
				}
				if !errors.Is(err, sql.ErrNoRows) {
					return fmt.Errorf("forms: check form use: %w", err)
				}
			}
		}
		return e.Next()
	})
}

// settleDefault keeps exactly one default per host: a form saved as default
// clears the flag on its siblings. The save goes through the normal hook path
// so realtime and audit see it; settlingKey lets it past the guard.
func settleDefault(ctx context.Context, app core.App, saved *core.Record) error {
	if !saved.GetBool("is_default") {
		return nil
	}
	others, err := app.FindRecordsByFilter(formsCollection, "host = {:host} && is_default = true && id != {:id}", "", 0, 0,
		dbx.Params{"host": saved.GetString("host"), "id": saved.Id})
	if err != nil {
		return err
	}
	for _, o := range others {
		o.Set("is_default", false)
		if err := app.SaveWithContext(context.WithValue(ctx, settlingKey, true), o); err != nil {
			return err
		}
	}
	return nil
}
