package coreserver

import (
	"slices"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestAutoUpgradeMigration(t *testing.T) {
	app := adminConsoleTestApp(t)

	col, err := app.FindCollectionByNameOrId("autoupgrade_state")
	if err != nil {
		t.Fatalf("autoupgrade_state missing: %v", err)
	}
	for _, f := range []string{"kind", "fingerprint", "target", "reason", "first_seen", "last_notified", "cleared", "install_log"} {
		if col.Fields.GetByName(f) == nil {
			t.Errorf("autoupgrade_state.%s missing", f)
		}
	}
	const owner = `@request.auth.id != "" && @request.auth.disabled != true && @request.auth.role = "owner"`
	if col.ListRule == nil || *col.ListRule != owner {
		t.Errorf("listRule = %v, want owner-only", col.ListRule)
	}
	if col.UpdateRule == nil || *col.UpdateRule != owner {
		t.Errorf("updateRule = %v, want owner-only", col.UpdateRule)
	}
	if col.CreateRule != nil || col.DeleteRule != nil {
		t.Error("create/delete must be server-only (nil rule)")
	}

	kind, ok := col.Fields.GetByName("kind").(*core.SelectField)
	if !ok || !slices.Equal(kind.Values, []string{"pause", "blocked", "failed"}) {
		t.Errorf("autoupgrade_state.kind = %+v, want pause, blocked, failed", col.Fields.GetByName("kind"))
	}

	log, err := app.FindCollectionByNameOrId("pkg_install_log")
	if err != nil {
		t.Fatal(err)
	}
	if log.Fields.GetByName("trigger") == nil || log.Fields.GetByName("changes") == nil {
		t.Error("pkg_install_log.trigger / .changes missing")
	}

	row, err := app.FindFirstRecordByFilter("system_settings", "key = 'autoupgrade.enabled'")
	if err != nil {
		t.Fatalf("seed row missing: %v", err)
	}
	if row.GetString("value") != "true" {
		t.Errorf("autoupgrade.enabled = %q, want \"true\"", row.GetString("value"))
	}
}
