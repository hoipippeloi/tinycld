package audit

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// redactTestApp saves a fictional "gadgets" collection: serial and color are
// plain text fields, pin is a hidden one. It returns a stored gadget with
// serial A1, color red and pin 1111.
func redactTestApp(t *testing.T) (*tests.TestApp, *core.Record) {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	createAuditLogsCollection(t, app)

	col := core.NewBaseCollection("gadgets")
	col.Fields.Add(
		&core.TextField{Name: "serial"},
		&core.TextField{Name: "color"},
		&core.TextField{Name: "pin", Hidden: true},
	)
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}

	rec := core.NewRecord(col)
	rec.Set("serial", "A1")
	rec.Set("color", "red")
	rec.Set("pin", "1111")
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return app, rec
}

// loadGadget reads the stored gadget fresh, so original and current are two
// records with their own values.
func loadGadget(t *testing.T, app core.App, id string) *core.Record {
	t.Helper()
	rec, err := app.FindRecordById("gadgets", id)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func redactedMarker() map[string]any {
	return map[string]any{"before": "[redacted]", "after": "[redacted]", "redacted": true}
}

func singleAuditRow(t *testing.T, app core.App, action, recordID string) *core.Record {
	t.Helper()
	rows, err := app.FindRecordsByFilter(
		"audit_logs",
		"action = {:action} && resource_id = {:id}",
		"", 0, 0,
		map[string]any{"action": action, "id": recordID},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 %q audit row for %s, got %d", action, recordID, len(rows))
	}
	return rows[0]
}

func TestRedactedValueIsTheFixedMarker(t *testing.T) {
	if RedactedValue != "[redacted]" {
		t.Fatalf("RedactedValue = %q, want %q", RedactedValue, "[redacted]")
	}
}

func TestComputeDiffRedactsListedAndHiddenFieldsButLogsTheChange(t *testing.T) {
	app, rec := redactTestApp(t)
	original := loadGadget(t, app, rec.Id)
	current := loadGadget(t, app, rec.Id)
	current.Set("serial", "B2")
	current.Set("color", "blue")
	current.Set("pin", "2222")

	diff := ComputeDiff(original, current, "serial")

	if !reflect.DeepEqual(diff["serial"], redactedMarker()) {
		t.Fatalf("diff[serial] = %#v, want the redacted marker %#v", diff["serial"], redactedMarker())
	}
	wantColor := map[string]any{"before": "red", "after": "blue"}
	if !reflect.DeepEqual(diff["color"], wantColor) {
		t.Fatalf("diff[color] = %#v, want %#v", diff["color"], wantColor)
	}
	if !reflect.DeepEqual(diff["pin"], redactedMarker()) {
		t.Fatalf("diff[pin] (hidden) = %#v, want the redacted marker %#v", diff["pin"], redactedMarker())
	}

	raw, err := json.Marshal(diff)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"A1", "B2", "1111", "2222"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("the diff JSON leaks %q: %s", secret, raw)
		}
	}
}

func TestComputeDiffLeavesAnUnchangedRedactedFieldOut(t *testing.T) {
	app, rec := redactTestApp(t)
	original := loadGadget(t, app, rec.Id)
	current := loadGadget(t, app, rec.Id)
	current.Set("color", "blue")

	diff := ComputeDiff(original, current, "serial")

	if v, ok := diff["serial"]; ok {
		t.Fatalf("an unchanged redacted field must have no diff entry, got diff[serial] = %#v", v)
	}
}

func TestComputeDiffWithNoRedactListShowsTheValues(t *testing.T) {
	app, rec := redactTestApp(t)
	original := loadGadget(t, app, rec.Id)
	current := loadGadget(t, app, rec.Id)
	current.Set("serial", "B2")
	current.Set("pin", "2222")

	diff := ComputeDiff(original, current)

	wantSerial := map[string]any{"before": "A1", "after": "B2"}
	if !reflect.DeepEqual(diff["serial"], wantSerial) {
		t.Fatalf("diff[serial] = %#v, want %#v", diff["serial"], wantSerial)
	}
	if !reflect.DeepEqual(diff["pin"], redactedMarker()) {
		t.Fatalf("diff[pin] (hidden) = %#v, want the redacted marker %#v", diff["pin"], redactedMarker())
	}
}

func TestBuildSnapshotRedactsListedAndHiddenFields(t *testing.T) {
	app, rec := redactTestApp(t)

	snapshot := BuildSnapshot(loadGadget(t, app, rec.Id), "serial")

	if snapshot["serial"] != "[redacted]" {
		t.Fatalf("snapshot[serial] = %#v, want %q", snapshot["serial"], "[redacted]")
	}
	if snapshot["color"] != "red" {
		t.Fatalf("snapshot[color] = %#v, want the stored value %q", snapshot["color"], "red")
	}
	if snapshot["pin"] != "[redacted]" {
		t.Fatalf("snapshot[pin] (hidden) = %#v, want %q", snapshot["pin"], "[redacted]")
	}
}

func TestLogUpdateStoresTheMarkerForARedactedField(t *testing.T) {
	app, rec := redactTestApp(t)
	original := loadGadget(t, app, rec.Id)
	current := loadGadget(t, app, rec.Id)
	current.Set("serial", "B2")

	logUpdate(app, current, original, requestInfoOf(nil), "gadgets", DefaultLabelExtractor, []string{"serial"})

	row := singleAuditRow(t, app, "updated", rec.Id)
	raw := row.GetString("changes")
	if strings.Contains(raw, "B2") || strings.Contains(raw, "A1") {
		t.Fatalf("the stored changes leak the serial: %s", raw)
	}
	var changes map[string]any
	if err := row.UnmarshalJSONField("changes", &changes); err != nil {
		t.Fatalf("changes is not JSON: %v (%s)", err, raw)
	}
	if !reflect.DeepEqual(changes["serial"], redactedMarker()) {
		t.Fatalf("stored changes[serial] = %#v, want the redacted marker %#v", changes["serial"], redactedMarker())
	}
}

func TestLogDeleteStoresTheMarkerInTheSnapshot(t *testing.T) {
	app, rec := redactTestApp(t)

	logDelete(app, rec.Id, "label", BuildSnapshot(loadGadget(t, app, rec.Id), "serial"), requestInfoOf(nil), "gadgets")

	row := singleAuditRow(t, app, "deleted", rec.Id)
	raw := row.GetString("snapshot")
	if !strings.Contains(raw, `"serial":"[redacted]"`) {
		t.Fatalf("the stored snapshot must hold %s, got %s", `"serial":"[redacted]"`, raw)
	}
	if strings.Contains(raw, "A1") {
		t.Fatalf("the stored snapshot leaks the serial: %s", raw)
	}
}
