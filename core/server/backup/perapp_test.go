package backup

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/backup/format"
	"tinycld.org/core/installjob"
)

func bareApp(t *testing.T) core.App {
	t.Helper()
	return core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
}

// Each app claims its own ceiling, and counts its own manual runs.
func TestDailyLimitIsPerApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	SetDailyLimit(a, func(core.App) int { return 1 })
	SetDailyLimit(a, func(core.App) int { return 99 })
	if got := dailyLimit(a); got != 1 {
		t.Fatalf("a's limit = %d, want its first claim (1)", got)
	}
	if got := dailyLimit(b); got != defaultDailyLimit {
		t.Fatalf("b's limit = %d, want the default: a's claim must not reach b", got)
	}
	SetDailyLimit(b, func(core.App) int { return 2 })
	if got := dailyLimit(b); got != 2 {
		t.Fatalf("b's limit = %d, want b's own claim (2)", got)
	}

	if !allowManual(a) {
		t.Fatal("a's first manual run was refused")
	}
	if allowManual(a) {
		t.Fatal("a's second manual run passed a ceiling of 1")
	}
	if !allowManual(b) {
		t.Fatal("a's runs were counted against b")
	}
}

// The rebuilder, the restart seam, the restoring flag and the restores
// waiting for a URL all belong to one app.
func TestRestoreStateIsPerApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)

	RegisterRebuilder(a, func(context.Context, *installjob.Job, format.Lockfile) error { return nil })
	if !HasRebuilder(a) || HasRebuilder(b) {
		t.Fatalf("HasRebuilder a=%v b=%v, want a only", HasRebuilder(a), HasRebuilder(b))
	}

	SetRestart(a, func() bool { return false })
	if requestRestart(a) {
		t.Fatal("a's declining restart seam was not used")
	}
	if !restartRequested(a) || restartRequested(b) {
		t.Fatal("a restart asked for on a was recorded on b")
	}

	setRestoring(a, true)
	if !Restoring(a) || Restoring(b) {
		t.Fatalf("Restoring a=%v b=%v, want a only", Restoring(a), Restoring(b))
	}

	src := format.NewRangeSource(context.Background(), "http://127.0.0.1:1/x")
	t.Cleanup(func() { _ = src.Close() })
	stopWaiting := registerWaiting(a, "job_1", src)
	defer stopWaiting()
	if err := SwapSource(b, "job_1", "http://127.0.0.1:1/y"); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("SwapSource on b = %v, want ErrNotWaiting: a's restore must not take b's URL", err)
	}
	if err := SwapSource(a, "job_1", "http://127.0.0.1:1/y"); err != nil {
		t.Fatalf("SwapSource on a = %v", err)
	}
}

// The maintenance 503 answers for the app that is restoring, not for every
// app in the process.
func TestMaintenanceMiddlewareReadsItsOwnApp(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	setRestoring(a, true)

	for _, tc := range []struct {
		app  core.App
		want int
	}{{a, http.StatusServiceUnavailable}, {b, http.StatusOK}} {
		rec := httptest.NewRecorder()
		re := &core.RequestEvent{App: tc.app}
		re.Request = httptest.NewRequest(http.MethodPost, "/api/collections/users/records", nil)
		re.Response = rec
		reached := false
		err := MaintenanceMiddleware()(re)
		if err == nil && rec.Code == http.StatusOK && rec.Body.Len() == 0 {
			reached = true
		}
		switch tc.want {
		case http.StatusServiceUnavailable:
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("the restoring app answered %d, want 503", rec.Code)
			}
		default:
			if !reached {
				t.Fatalf("an app with no restore was put behind the 503 (status %d)", rec.Code)
			}
		}
	}
}

// StopAll on app A cancels A's transfers and no other app's; Arm gives A a
// fresh lifetime.
func TestStopAllCancelsOnlyThatAppsTransfers(t *testing.T) {
	a, b := bareApp(t), bareApp(t)
	Arm(a)
	Arm(b)
	ctxA, ctxB := TransferContext(a), TransferContext(b)

	if err := StopAll(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if ctxA.Err() == nil {
		t.Fatal("StopAll(a) did not cancel a's transfers")
	}
	if ctxB.Err() != nil {
		t.Fatal("StopAll(a) cancelled b's transfers")
	}

	Arm(a)
	if TransferContext(a).Err() != nil {
		t.Fatal("Arm(a) did not give a a fresh lifetime")
	}
}
