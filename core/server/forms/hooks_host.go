// tinycld/core/server/forms/hooks_host.go
package forms

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
)

// DefaultFormID returns the id of a host's default form, or "" when none.
func DefaultFormID(app core.App, hostKey string) (string, error) {
	r, err := app.FindFirstRecordByFilter(formsCollection, "host = {:host} && is_default = true", dbx.Params{"host": hostKey})
	if err != nil {
		if r == nil {
			return "", nil
		}
		return "", err
	}
	return r.Id, nil
}

func loadForm(app core.App, host *Host, id string) (*core.Record, *Definition, error) {
	rec, err := app.FindRecordById(formsCollection, id)
	if err != nil {
		return nil, nil, err
	}
	if rec.GetString("host") != host.Key {
		return nil, nil, fmt.Errorf("form %s belongs to %s", id, rec.GetString("host"))
	}
	def, err := ParseDefinition([]byte(rec.GetString("definition")))
	return rec, def, err
}

func fieldsOf(record *core.Record, column string) (map[string]any, error) {
	raw, err := json.Marshal(record.Get(column))
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// recordValues assembles the values the rules read: builtin columns from the
// record, custom keys from the JSON column. Evaluate needs JSON-decoded types,
// while record.Get returns ints, slices and DateTime, so the map is
// round-tripped through JSON.
func recordValues(host *Host, def *Definition, record *core.Record) map[string]any {
	fields, _ := fieldsOf(record, host.FieldsColumn)
	values := map[string]any{}
	for _, f := range def.Fields {
		if f.Kind != "builtin" {
			values[f.Key] = fields[f.Key]
			continue
		}
		if b := host.Builtin(f.Key); b != nil && b.Storage == "column" {
			values[f.Key] = record.Get(f.Key)
		}
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return map[string]any{}
	}
	normalized := map[string]any{}
	if err := json.Unmarshal(raw, &normalized); err != nil {
		return map[string]any{}
	}
	return normalized
}

// otherFormField finds a custom field of another form of the same host, so a
// value kept across a type change is still checked against its own kind.
func otherFormField(app core.App, host *Host, key string) *Field {
	forms, err := app.FindRecordsByFilter(formsCollection, "host = {:host}", "", 0, 0, dbx.Params{"host": host.Key})
	if err != nil {
		return nil
	}
	for _, rec := range forms {
		odef, err := ParseDefinition([]byte(rec.GetString("definition")))
		if err != nil {
			continue
		}
		if f := odef.Field(key); f != nil {
			return f
		}
	}
	return nil
}

func checkKind(f *Field, v any) string {
	if v == nil {
		return ""
	}
	switch f.Kind {
	case "text", "textarea", "richtext", "markdown", "date":
		s, ok := v.(string)
		if !ok {
			return f.Label + " must be text"
		}
		if f.MaxLength != nil && len([]rune(s)) > *f.MaxLength {
			return f.Label + " is too long"
		}
	case "number":
		n, ok := v.(float64)
		if !ok {
			return f.Label + " must be a number"
		}
		if f.Min != nil && n < *f.Min {
			return f.Label + " is below its minimum"
		}
		if f.Max != nil && n > *f.Max {
			return f.Label + " is above its maximum"
		}
	case "toggle":
		if _, ok := v.(bool); !ok {
			return f.Label + " must be on or off"
		}
	case "select":
		allowed := map[string]bool{}
		for _, o := range f.Options {
			allowed[o.Value] = true
		}
		check := func(x any) bool { s, ok := x.(string); return ok && allowed[s] }
		if f.Multiple {
			arr, ok := v.([]any)
			if !ok {
				return f.Label + " must be a list"
			}
			for _, x := range arr {
				if !check(x) {
					return f.Label + " has a value that is not an option"
				}
			}
		} else if !check(v) {
			return f.Label + " is not one of its options"
		}
	case "user", "file":
		if f.Multiple {
			if _, ok := v.([]any); !ok {
				return f.Label + " must be a list"
			}
		} else if _, ok := v.(string); !ok {
			return f.Label + " must be an id"
		}
	case "checklist":
		arr, ok := v.([]any)
		if !ok {
			return f.Label + " must be a list"
		}
		for _, it := range arr {
			m, ok := it.(map[string]any)
			if !ok {
				return f.Label + " has a bad item"
			}
			if _, ok := m["id"].(string); !ok {
				return f.Label + " has an item without an id"
			}
		}
	}
	return ""
}

func validateHostRecord(app core.App, host *Host, e *core.RecordEvent, isCreate bool) error {
	formID := e.Record.GetString(host.FormColumn)
	if formID == "" {
		id, err := DefaultFormID(app, host.Key)
		if err != nil {
			return err
		}
		if id == "" {
			return nil // no forms seeded yet; nothing to validate against
		}
		e.Record.Set(host.FormColumn, id)
		formID = id
	}
	_, def, err := loadForm(app, host, formID)
	if err != nil {
		return fieldErr(host.FormColumn, "validation_unknown_form", "This form does not belong to this record type.")
	}
	fields, err := fieldsOf(e.Record, host.FieldsColumn)
	if err != nil {
		return fieldErr(host.FieldsColumn, "validation_invalid_json", "Custom fields are not valid JSON.")
	}
	errs := validation.Errors{}
	for key, v := range fields {
		f := def.Field(key)
		if f == nil {
			f = otherFormField(app, host, key)
			if f == nil {
				errs[host.FieldsColumn+"."+key] = validation.NewError("validation_unknown_field", "Unknown field "+key)
				continue
			}
		}
		if f.Kind == "builtin" {
			errs[host.FieldsColumn+"."+key] = validation.NewError("validation_builtin_in_json", key+" is a built-in field and is not stored here")
			continue
		}
		if f.Collaborative {
			continue
		}
		if msg := checkKind(f, v); msg != "" {
			errs[host.FieldsColumn+"."+key] = validation.NewError("validation_wrong_kind", msg)
		}
	}
	if len(errs) > 0 {
		return errs
	}
	values := recordValues(host, def, e.Record)
	state, err := Evaluate(def, values, Context{Today: time.Now().Format("2006-01-02")})
	if err != nil {
		return fieldErr(host.FieldsColumn, "validation_rules_failed", "The form rules could not be evaluated.")
	}
	var prev map[string]any
	if !isCreate {
		// Read the stored row: Original() of a record created in this process is the pre-create state.
		if stored, err := app.FindRecordById(host.Collection, e.Record.Id); err == nil {
			prev, _ = fieldsOf(stored, host.FieldsColumn)
		}
	}
	for _, f := range def.Fields {
		st := state.Fields[f.Key]
		if !st.Required {
			continue
		}
		if f.Kind == "builtin" {
			continue // PocketBase enforces required columns; rows and sections never travel here
		}
		if f.Collaborative {
			continue
		}
		v := fields[f.Key]
		if !isEmpty(v) {
			continue
		}
		if isCreate || (prev != nil && !isEmpty(prev[f.Key])) {
			errs[host.FieldsColumn+"."+f.Key] = validation.NewError("validation_required", f.Label+" is required")
		}
	}
	if len(errs) > 0 {
		return errs
	}
	return nil
}

func bindHostHooks(app core.App, defs *Defs) {
	for i := range defs.Hosts {
		host := &defs.Hosts[i]
		app.OnRecordCreate(host.Collection).BindFunc(func(e *core.RecordEvent) error {
			if err := validateHostRecord(e.App, host, e, true); err != nil {
				return err
			}
			return e.Next()
		})
		app.OnRecordUpdate(host.Collection).BindFunc(func(e *core.RecordEvent) error {
			if err := validateHostRecord(e.App, host, e, false); err != nil {
				return err
			}
			return e.Next()
		})
	}
}
