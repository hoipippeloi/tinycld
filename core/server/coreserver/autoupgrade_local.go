package coreserver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sort"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/autoupgrade"
	"tinycld.org/core/background"
	"tinycld.org/core/installjob"
	"tinycld.org/core/readonly"
)

const (
	tickEvery            = time.Hour
	resultDisabledPrefix = "checks disabled: "
	resultOff            = "off"
	resultReadOnly       = "read-only"
	resultUnrestored     = "paused: a database backup needs attention"
	resultStopped        = "stopped: the server is shutting down"
)

// localScheduler is the Delegate for a deployment that can rebuild itself. It
// wakes every hour; inside the owner's window it applies the newest compatible
// set through the same path as a manual version change, so the entrypoint's
// health probe commits or rolls back exactly as it does for a person.
//
// The loop runs on the app's background runner, so the terminate waits for a
// tick in progress. A tick is short: its network lookups and its mail are
// bound to the ctx the terminate cancels, and a version change it starts is
// handed to the rebuild runner, which the tick does not wait for.
type localScheduler struct {
	app      core.App
	jobs     *background.Jobs
	every    time.Duration
	now      func() time.Time
	discover func(ctx context.Context) ([]VersionInfo, error)
	solve    solveFunc
	apply    func([]installjob.VersionChange) error
	notify   func(ctx context.Context, n notice)
	// disabled is why ticks do nothing ("" = active). The switch still works:
	// a development build or a test server must not rebuild itself at 3am.
	disabled string

	mu         sync.Mutex
	lastRun    time.Time
	lastResult string
}

func newLocalScheduler(app *pocketbase.PocketBase) *localScheduler {
	s := &localScheduler{
		app:   app,
		jobs:  background.For(app, "coreserver"),
		every: tickEvery,
		now:   time.Now,
		discover: func(ctx context.Context) ([]VersionInfo, error) {
			rows, err := app.FindRecordsByFilter("pkg_registry", "id != ''", "slug", 0, 0)
			if err != nil {
				return nil, err
			}
			return versionInfosForRows(rows, func(spec string) (pkgSource, []string, string) {
				return versionsForSpecContext(ctx, spec)
			}), nil
		},
		solve: func(c map[string]string) ([]compatViolation, error) { return solveRegistryCompat(app, c) },
		apply: func(c []installjob.VersionChange) error {
			_, err := beginVersionChange(app, c, "auto")
			return err
		},
		notify: func(ctx context.Context, n notice) {
			notifyAdmins(app, func(name, email, subj, html, text string) error {
				return sendContext(ctx, app, name, email, subj, html, text)
			}, n)
		},
	}
	switch {
	case isDevelopment():
		s.disabled = "development build"
	case os.Getenv("TINYCLD_AUTOUPGRADE_DISABLED") == "1":
		s.disabled = "TINYCLD_AUTOUPGRADE_DISABLED is set"
	}
	return s
}

// readSystemSetting returns "" without an error only when the row does not
// exist. Any other failure is returned: a tick must not mistake an unreadable
// switch for "off", or an unreadable window for the default one.
func readSystemSetting(app core.App, key string) (string, error) {
	row, err := app.FindFirstRecordByFilter("system_settings", "key = {:k}", map[string]any{"k": key})
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read %s: %w", key, err)
	}
	return row.GetString("value"), nil
}

func (s *localScheduler) window() (autoupgrade.Window, error) {
	raw, err := readSystemSetting(s.app, autoupgrade.KeyWindow)
	if err != nil {
		return autoupgrade.Window{}, err
	}
	if raw == "" {
		raw = autoupgrade.DefaultWindow
	}
	w, err := autoupgrade.ParseWindow(raw)
	if err != nil {
		srvLog.Warn("auto-upgrade: bad window, using default", "window", raw, "err", err)
		w, _ = autoupgrade.ParseWindow(autoupgrade.DefaultWindow)
	}
	return w, nil
}

// PolicyChanged has nothing to push: every tick reads the stored flag.
func (s *localScheduler) PolicyChanged(_ context.Context, enabled bool) error {
	srvLog.Info("auto-upgrade policy", "enabled", enabled)
	return nil
}

// Status reports a next check only when one will run. With checks disabled
// or the switch off, the result says so instead; Available stays true so the
// owner can still use the switch.
func (s *localScheduler) Status(context.Context) (autoupgrade.Status, error) {
	if s.disabled != "" {
		return autoupgrade.Status{Available: true, LastResult: resultDisabledPrefix + s.disabled}, nil
	}
	enabled, err := readSystemSetting(s.app, autoupgrade.KeyEnabled)
	if err != nil {
		return autoupgrade.Status{}, err
	}
	if enabled != "true" {
		return autoupgrade.Status{Available: true, LastResult: resultOff}, nil
	}
	s.mu.Lock()
	lastRun, lastResult := s.lastRun, s.lastResult
	s.mu.Unlock()
	if lastRun.IsZero() {
		lastRun, lastResult = lastAutoJob(s.app)
	}
	// Said from boot on, not only after the next tick. No next check is
	// given: none will upgrade until an operator deals with the backup, and
	// without one the status line shows this result alone.
	if hasUnrestored() {
		return autoupgrade.Status{Available: true, LastRun: lastRun, LastResult: resultUnrestored}, nil
	}
	w, err := s.window()
	if err != nil {
		return autoupgrade.Status{}, err
	}
	return autoupgrade.Status{
		Available:  true,
		LastRun:    lastRun,
		LastResult: lastResult,
		NextCheck:  w.NextStart(s.now()),
	}, nil
}

// lastAutoJob reads the newest automatic job from the install log, so the
// status survives the restart every upgrade ends with.
func lastAutoJob(app core.App) (time.Time, string) {
	rows, err := app.FindRecordsByFilter("pkg_install_log", "trigger = 'auto'", "-created", 1, 0)
	if err != nil || len(rows) == 0 {
		return time.Time{}, ""
	}
	results := map[string]string{"success": "upgraded", "rolled_back": "rolled back", "failed": "failed", "running": "upgrading"}
	return rows[0].GetDateTime("created").Time(), results[rows[0].GetString("status")]
}

// Start runs the hourly loop until ctx ends or the app terminates.
func (s *localScheduler) Start(ctx context.Context) {
	s.jobs.Run("auto-upgrade checks", func(jobCtx context.Context) {
		loopCtx, cancel := context.WithCancel(jobCtx)
		defer cancel()
		defer context.AfterFunc(ctx, cancel)()
		s.loop(loopCtx)
	})
}

func (s *localScheduler) loop(ctx context.Context) {
	every := s.every
	if every <= 0 {
		every = tickEvery
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.safeTick(ctx)
		}
	}
}

// safeTick is one tick whose panic is logged and recorded, so the next
// hour's tick still runs.
func (s *localScheduler) safeTick(ctx context.Context) {
	defer func() {
		if p := recover(); p != nil {
			srvLog.Error("auto-upgrade: check panicked", "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
			s.record(fmt.Sprintf("failed: internal error: %v", p))
		}
	}()
	s.tick(ctx)
}

func (s *localScheduler) record(result string) string {
	s.mu.Lock()
	s.lastRun, s.lastResult = s.now(), result
	s.mu.Unlock()
	return result
}

// tick returns early once ctx has ended, before its next database write,
// mail or version change.
func (s *localScheduler) tick(ctx context.Context) string {
	if s.disabled != "" {
		return s.record(resultDisabledPrefix + s.disabled)
	}
	if ctx.Err() != nil {
		return resultStopped
	}
	// Read-only mode means a second process is about to migrate this
	// database. The tick is not a cron job, so the cron guard does not skip
	// it, and a version change or a reminder row written now would be written
	// against a schema this process may not know. A skipped tick is not made
	// up; the next one runs an hour later.
	if readonly.Active() {
		return resultReadOnly
	}
	// A backup a rollback could not restore means the database was migrated
	// by a build that is not serving. Another upgrade would migrate it further
	// and take a new backup from it, so nothing runs until an operator puts
	// the backup back or deletes it.
	if hasUnrestored() {
		return s.record(resultUnrestored)
	}
	enabled, err := readSystemSetting(s.app, autoupgrade.KeyEnabled)
	if err != nil {
		return s.record("failed: " + err.Error())
	}
	if enabled != "true" {
		return resultOff
	}
	// Before the window check: the last attempt of a window ends after the
	// window's last tick, and its failure must not wait a day to be told.
	if err := reportFailedAutoJob(s.app, s.now(), func(n notice) { s.notify(ctx, n) }); err != nil {
		srvLog.Warn("auto-upgrade: failure report failed", "err", err)
	}
	w, err := s.window()
	if err != nil {
		return s.record("failed: " + err.Error())
	}
	now := s.now()
	if !w.Contains(now) {
		return "waiting for window"
	}
	if installjob.Running() {
		return "busy"
	}
	notify := func(n notice) { s.notify(ctx, n) }
	if err := remindBlocked(s.app, now, notify); err != nil {
		srvLog.Warn("auto-upgrade: blocked reminders failed", "err", err)
	}
	if ctx.Err() != nil {
		return resultStopped
	}

	infos, err := s.discover(ctx)
	if ctx.Err() != nil {
		return resultStopped
	}
	if err != nil {
		return s.record("failed: " + err.Error())
	}
	plan, err := planUpgrade(infos, s.solve)
	if err != nil {
		return s.record("failed: " + err.Error())
	}
	if plan.Target == nil && len(plan.Violations) > 0 {
		fp := fingerprint(plan.Wanted, plan.Violations)
		if err := recordPause(s.app, fp, plan.Wanted, formatViolations(plan.Violations), now, notify); err != nil {
			srvLog.Warn("auto-upgrade: record pause failed", "err", err)
		}
		return s.record("paused: conflict")
	}
	if err := clearPause(s.app); err != nil {
		srvLog.Warn("auto-upgrade: clear pause failed", "err", err)
	}
	if len(plan.Target) == 0 {
		return s.record("no updates")
	}
	blocked, err := blockedFingerprints(s.app)
	if err != nil {
		return s.record("failed: " + err.Error())
	}
	if blocked[fingerprint(plan.Target, nil)] {
		return s.record("blocked")
	}

	changes := make([]installjob.VersionChange, 0, len(plan.Target))
	for _, slug := range sortedKeys(plan.Target) {
		changes = append(changes, installjob.VersionChange{Slug: slug, TargetVersion: plan.Target[slug]})
	}
	if ctx.Err() != nil {
		return resultStopped
	}
	if err := s.apply(changes); err != nil {
		srvLog.Warn("auto-upgrade: apply failed", "err", err)
		return s.record("failed: " + err.Error())
	}
	return s.record("upgrading")
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
