package coreserver

import (
	"time"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/installjob"
)

const rolledBackReason = "The update did not pass its health check after the restart, so it was rolled back."

// reconcileAutoUpgradeResults runs at boot, after ReconcileRolledBackInstall
// has marked a stranded row rolled_back. Each rolled-back automatic job blocks
// its set so the next window does not try it again. A failed job is not
// blocked: it failed before the live app changed, so trying again is safe.
func reconcileAutoUpgradeResults(app core.App, now time.Time, notify func(notice)) {
	rows, err := app.FindRecordsByFilter("pkg_install_log",
		"trigger = 'auto' && status = 'rolled_back'", "-created", 0, 0)
	if err != nil {
		srvLog.Warn("auto-upgrade: reconcile query failed", "err", err)
		return
	}
	for _, r := range rows {
		target := jobTarget(r)
		if len(target) == 0 {
			continue
		}
		if err := recordBlocked(app, fingerprint(target, nil), target, rolledBackReason, r.Id, now, notify); err != nil {
			srvLog.Warn("auto-upgrade: record blocked failed", "installLog", r.Id, "err", err)
		}
	}
}

// jobTarget is the version set an install log row tried, or nil when the row
// does not record one.
func jobTarget(r *core.Record) map[string]string {
	var changes []installjob.VersionChange
	if err := r.UnmarshalJSONField("changes", &changes); err != nil || len(changes) == 0 {
		return nil
	}
	target := make(map[string]string, len(changes))
	for _, c := range changes {
		target[c.Slug] = c.TargetVersion
	}
	return target
}

// maxFailureReason keeps a failed build's error within the state row's
// reason field and an email a person can read.
const maxFailureReason = 2000

// reportFailedAutoJob tells the owners when the newest automatic job failed
// and forgets the failure once one succeeds or is rolled back (a rollback has
// its own notice). A running or pending job has no result yet.
func reportFailedAutoJob(app core.App, now time.Time, notify func(notice)) error {
	rows, err := app.FindRecordsByFilter("pkg_install_log", "trigger = 'auto'", "-created", 1, 0)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	switch row := rows[0]; row.GetString("status") {
	case "failed":
		target := jobTarget(row)
		if len(target) == 0 {
			return nil
		}
		reason := row.GetString("error")
		if r := []rune(reason); len(r) > maxFailureReason {
			reason = string(r[:maxFailureReason]) + "…"
		}
		return recordFailure(app, fingerprint(target, nil), target, reason, now, notify)
	case "success", "rolled_back":
		return clearFailure(app)
	}
	return nil
}
