// tinycld/core/server/forms/seed.go
package forms

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// defaultDefinition mirrors defaultDefinitionFor in core/lib/forms/host.ts:
// every builtin on one page, in declared order.
func defaultDefinition(host *Host) *Definition {
	def := &Definition{Version: 1, Pages: []Page{{Key: "main", Title: host.Label}}, Defaults: map[string]any{}, Rules: []Rule{}}
	for _, b := range host.Builtins {
		def.Fields = append(def.Fields, Field{Key: b.Key, Kind: "builtin", Page: "main", Label: b.Label, Required: b.Required})
	}
	return def
}

func slugOf(label string) string {
	s := strings.ToLower(strings.TrimSpace(label))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" || out[0] < 'a' || out[0] > 'z' {
		out = "form_" + out
	}
	return out
}

// SeedDefaults gives every installed host one default form and points
// records with an empty form column at it. Idempotent; runs on serve.
func SeedDefaults(app core.App, defs *Defs) error {
	col, err := app.FindCollectionByNameOrId(formsCollection)
	if err != nil {
		return nil // forms migration not applied yet; nothing to seed
	}
	for i := range defs.Hosts {
		host := &defs.Hosts[i]
		if _, err := app.FindCollectionByNameOrId(host.Collection); err != nil {
			log.Info("skipping form seed, host collection absent", "host", host.Key)
			continue
		}
		id, err := DefaultFormID(app, host.Key)
		if err != nil {
			return err
		}
		if id == "" {
			existing, _ := app.FindRecordsByFilter(formsCollection, "host = {:host}", "", 1, 0, dbx.Params{"host": host.Key})
			if len(existing) > 0 {
				// Forms exist but none is default (a manual edit). Promote the first.
				existing[0].Set("is_default", true)
				if err := app.Save(existing[0]); err != nil {
					return err
				}
				id = existing[0].Id
			} else {
				raw, err := json.Marshal(defaultDefinition(host))
				if err != nil {
					return err
				}
				rec := core.NewRecord(col)
				rec.Set("host", host.Key)
				rec.Set("name", host.Label)
				rec.Set("slug", slugOf(host.Label))
				rec.Set("definition", raw)
				rec.Set("is_default", true)
				rec.Set("order", 0)
				if err := app.Save(rec); err != nil {
					return fmt.Errorf("forms: seed default for %s: %w", host.Key, err)
				}
				id = rec.Id
			}
		}
		_, err = app.DB().NewQuery(fmt.Sprintf("UPDATE {{%s}} SET [[%s]] = {:id} WHERE [[%s]] = '' OR [[%s]] IS NULL",
			host.Collection, host.FormColumn, host.FormColumn, host.FormColumn)).Bind(dbx.Params{"id": id}).Execute()
		if err != nil {
			return fmt.Errorf("forms: backfill %s: %w", host.Collection, err)
		}
	}
	return nil
}
