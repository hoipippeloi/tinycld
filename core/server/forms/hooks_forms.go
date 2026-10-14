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

func bindFormsHooks(app core.App, defs *Defs) {
	validate := func(e *core.RecordEvent) error {
		host := defs.Host(e.Record.GetString("host"))
		if host == nil {
			return fieldErr("host", "validation_unknown_host", "No installed package provides this form host.")
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
	app.OnRecordCreate(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		if err := validate(e); err != nil {
			return err
		}
		if err := e.Next(); err != nil {
			return err
		}
		return settleDefault(e.Context, e.App, e.Record)
	})
	app.OnRecordUpdate(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		if err := validate(e); err != nil {
			return err
		}
		orig, err := e.App.FindRecordById(formsCollection, e.Record.Id)
		if err != nil {
			return err
		}
		settling := e.Context != nil && e.Context.Value(settlingKey) == true
		if !settling && orig.GetBool("is_default") && !e.Record.GetBool("is_default") {
			return fieldErr("is_default", "validation_default_required", "Set another form as the default first.")
		}
		if err := e.Next(); err != nil {
			return err
		}
		return settleDefault(e.Context, e.App, e.Record)
	})
	app.OnRecordDelete(formsCollection).BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetBool("is_default") {
			return fieldErr("id", "validation_default_undeletable", "The default form cannot be deleted. Make another form the default first.")
		}
		host := defs.Host(e.Record.GetString("host"))
		if host != nil {
			if _, err := e.App.FindCollectionByNameOrId(host.Collection); err != nil {
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
