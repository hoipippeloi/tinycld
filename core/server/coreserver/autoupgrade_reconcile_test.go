package coreserver

import (
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestReconcileBlocksRolledBackAutoJob(t *testing.T) {
	app := adminConsoleTestApp(t)
	newInstallLogRow(t, app) // auto, rolled_back, mail -> 0.6.0
	var sent []notice
	notify := func(n notice) { sent = append(sent, n) }
	now := time.Date(2026, 10, 1, 3, 10, 0, 0, time.UTC)

	reconcileAutoUpgradeResults(app, now, notify)
	reconcileAutoUpgradeResults(app, now, notify)

	fps, err := blockedFingerprints(app)
	mustNil(t, err)
	if !fps[fingerprint(map[string]string{"mail": "0.6.0"}, nil)] {
		t.Fatal("set not blocked")
	}
	if len(sent) != 1 {
		t.Fatalf("%d emails, want 1", len(sent))
	}
}

func TestReconcileIgnoresManualAndFailedJobs(t *testing.T) {
	app := adminConsoleTestApp(t)
	id := newInstallLogRow(t, app)
	row, _ := app.FindRecordById("pkg_install_log", id)
	row.Set("trigger", "manual")
	mustNil(t, app.Save(row))
	id2 := newInstallLogRow(t, app)
	row2, _ := app.FindRecordById("pkg_install_log", id2)
	row2.Set("status", "failed")
	mustNil(t, app.Save(row2))

	reconcileAutoUpgradeResults(app, time.Now(), func(notice) { t.Fatal("must not notify") })
	if fps, _ := blockedFingerprints(app); len(fps) != 0 {
		t.Fatalf("blocked %v", fps)
	}
}

func failedAutoJob(t *testing.T, app core.App, version, errText string, at time.Time) {
	t.Helper()
	id := newInstallLogRow(t, app)
	row, err := app.FindRecordById("pkg_install_log", id)
	mustNil(t, err)
	row.Set("status", "failed")
	row.Set("error", errText)
	row.Set("changes", []map[string]string{{"slug": "mail", "targetVersion": version}})
	mustNil(t, app.Save(row))
	setCreated(t, app, id, pbTime(at))
}

func TestReportFailedAutoJobOncePerSet(t *testing.T) {
	app := adminConsoleTestApp(t)
	var sent []notice
	notify := func(n notice) { sent = append(sent, n) }
	t0 := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)

	failedAutoJob(t, app, "0.6.0", "pnpm install: exit status 1", t0)
	mustNil(t, reportFailedAutoJob(app, t0, notify))
	failedAutoJob(t, app, "0.6.0", "pnpm install: exit status 1", t0.Add(time.Hour))
	mustNil(t, reportFailedAutoJob(app, t0.Add(time.Hour), notify))
	if len(sent) != 1 {
		t.Fatalf("same failed set sent %d emails, want 1", len(sent))
	}
	if !strings.Contains(sent[0].BodyText, "mail 0.6.0") || !strings.Contains(sent[0].BodyText, "pnpm install: exit status 1") {
		t.Fatalf("notice does not name the set and the error: %q", sent[0].BodyText)
	}

	mustNil(t, reportFailedAutoJob(app, t0.Add(7*24*time.Hour), notify))
	if len(sent) != 2 || !strings.HasPrefix(sent[1].Subject, "Reminder:") {
		t.Fatalf("7-day reminder: %+v", sent)
	}

	failedAutoJob(t, app, "0.6.1", "go build: exit status 1", t0.Add(7*24*time.Hour+time.Hour))
	mustNil(t, reportFailedAutoJob(app, t0.Add(7*24*time.Hour+time.Hour), notify))
	if len(sent) != 3 || strings.HasPrefix(sent[2].Subject, "Reminder:") {
		t.Fatalf("a new failed set must notify at once: %+v", sent)
	}
	if rows, _ := app.FindRecordsByFilter("autoupgrade_state", "kind = 'failed'", "", 0, 0); len(rows) != 1 {
		t.Fatalf("%d failed rows, want 1", len(rows))
	}
}

func TestReportFailedAutoJobClearsAfterSuccess(t *testing.T) {
	app := adminConsoleTestApp(t)
	var sent []notice
	notify := func(n notice) { sent = append(sent, n) }
	t0 := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)

	failedAutoJob(t, app, "0.6.0", "boom", t0)
	mustNil(t, reportFailedAutoJob(app, t0, notify))

	id := newInstallLogRow(t, app)
	setCreated(t, app, id, pbTime(t0.Add(time.Hour)))
	row, _ := app.FindRecordById("pkg_install_log", id)
	row.Set("status", "running")
	mustNil(t, app.Save(row))
	mustNil(t, reportFailedAutoJob(app, t0.Add(time.Hour), notify))
	if rows, _ := app.FindRecordsByFilter("autoupgrade_state", "kind = 'failed'", "", 0, 0); len(rows) != 1 {
		t.Fatal("a running job must keep the failed row")
	}

	row.Set("status", "success")
	mustNil(t, app.Save(row))
	mustNil(t, reportFailedAutoJob(app, t0.Add(2*time.Hour), notify))
	if rows, _ := app.FindRecordsByFilter("autoupgrade_state", "kind = 'failed'", "", 0, 0); len(rows) != 0 {
		t.Fatal("failed row not cleared after a successful job")
	}

	failedAutoJob(t, app, "0.6.0", "boom", t0.Add(3*time.Hour))
	mustNil(t, reportFailedAutoJob(app, t0.Add(3*time.Hour), notify))
	if len(sent) != 2 {
		t.Fatalf("a failure after a success must notify again: %d emails, want 2", len(sent))
	}
}

func TestReportFailedAutoJobIgnoresManualJobs(t *testing.T) {
	app := adminConsoleTestApp(t)
	failedAutoJob(t, app, "0.6.0", "boom", time.Now())
	row, _ := app.FindFirstRecordByFilter("pkg_install_log", "status = 'failed'")
	row.Set("trigger", "manual")
	mustNil(t, app.Save(row))

	mustNil(t, reportFailedAutoJob(app, time.Now(), func(notice) { t.Fatal("must not notify") }))
}

func pbTime(at time.Time) string { return at.UTC().Format("2006-01-02 15:04:05.000Z") }
