package coreserver

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/installjob"
)

// TestShouldSuppressRestart is the H4 regression guard: a hooks-watcher restart
// (IsRestart) must be vetoed while a package pipeline holds the single-flight
// lock, so the generator's mid-pipeline pb_hooks rewrite can't tear the process
// down between steps. Non-restart terminations and idle-state restarts proceed.
func TestShouldSuppressRestart(t *testing.T) {
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})

	// Idle: a restart is allowed.
	if shouldSuppressRestart(app, true) {
		t.Error("restart suppressed while idle — should proceed")
	}
	// A non-restart termination is never suppressed.
	if shouldSuppressRestart(app, false) {
		t.Error("non-restart termination suppressed — should proceed")
	}

	// Job in flight: a restart must be vetoed.
	inflight := installjob.New("version_change", "", "")
	if _, ok := installjob.Claim(app, inflight); !ok {
		t.Fatal("claim must win against an idle interlock")
	}
	t.Cleanup(func() { installjob.Release(inflight) })

	if !shouldSuppressRestart(app, true) {
		t.Error("restart NOT suppressed during an in-flight pipeline — risks mid-pipeline teardown")
	}
	// Even mid-job, a non-restart termination (real shutdown) proceeds.
	if shouldSuppressRestart(app, false) {
		t.Error("non-restart termination suppressed mid-job — real shutdowns must proceed")
	}
}
