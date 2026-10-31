package sendquota

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// The claim is per app. It was one process-wide slot: the first app to claim
// it set every app's throttle, and a second app's own claim was ignored.
func TestClaimIsPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetLimits(a, func(core.App) SendLimits { return SendLimits{PerHour: 5} })
	SetLimits(b, func(core.App) SendLimits { return SendLimits{PerHour: 500} })

	if got := Limits(a); got.PerHour != 5 {
		t.Errorf("Limits(a).PerHour = %d, want 5", got.PerHour)
	}
	if got := Limits(b); got.PerHour != 500 {
		t.Errorf("Limits(b).PerHour = %d, want b's own 500; a's claim blocked b's", got.PerHour)
	}
}

// An app nobody claimed stays unlimited and unclaimed beside one that is.
func TestUnclaimedAppBesideAClaimedOne(t *testing.T) {
	a, b := newApp(t), newApp(t)
	SetLimits(a, func(core.App) SendLimits { return SendLimits{PerDay: 10} })

	if IsClaimed(b) {
		t.Error("a's claim reached b")
	}
	if got := Limits(b); got.PerDay != 0 || got.PerHour != 0 {
		t.Errorf("Limits(b) = %+v, want unlimited", got)
	}
}

func TestLimits_UnclaimedIsUnlimited(t *testing.T) {
	app := newApp(t)
	got := Limits(app)
	if got.PerDay != 0 || got.PerHour != 0 {
		t.Errorf("Limits = %+v, want the zero value (unlimited)", got)
	}
	if IsClaimed(app) {
		t.Error("IsClaimed = true with nobody having claimed the seam")
	}
}

func TestSetLimits_Resolves(t *testing.T) {
	app := newApp(t)
	SetLimits(app, func(core.App) SendLimits { return SendLimits{PerDay: 500, PerHour: 5} })

	got := Limits(app)
	if got.PerDay != 500 || got.PerHour != 5 {
		t.Errorf("Limits = %+v, want {500 5}", got)
	}
	if !IsClaimed(app) {
		t.Error("IsClaimed = false after SetLimits")
	}
}

// The claim is what makes a throttle a throttle. The deployment this limit
// is applied to must not be able to point it somewhere it controls.
func TestSetLimits_ClaimIsNotOverwritten(t *testing.T) {
	app := newApp(t)
	SetLimits(app, func(core.App) SendLimits { return SendLimits{PerHour: 5} })
	SetLimits(app, func(core.App) SendLimits { return SendLimits{PerHour: 99999} })

	if got := Limits(app); got.PerHour != 5 {
		t.Errorf("PerHour = %d, want the first resolver's 5", got.PerHour)
	}
}

func TestSetLimits_NilIsIgnored(t *testing.T) {
	app := newApp(t)
	SetLimits(app, nil)
	if IsClaimed(app) {
		t.Error("a nil resolver must not claim the seam")
	}
}

// A negative ceiling reaching an enforcement comparison would refuse every
// send. Normalizing here means that cannot happen even if whoever supplies
// the numbers never validated them.
func TestLimits_NegativeMeansUnlimited(t *testing.T) {
	app := newApp(t)
	SetLimits(app, func(core.App) SendLimits { return SendLimits{PerDay: -1, PerHour: -5} })

	got := Limits(app)
	if got.PerDay != 0 || got.PerHour != 0 {
		t.Errorf("Limits = %+v, want negatives normalized to unlimited", got)
	}
}

// The two ceilings are independent: a throttle sets PerHour without
// disturbing the ordinary daily volume, and vice versa.
func TestLimits_CeilingsAreIndependent(t *testing.T) {
	app := newApp(t)
	SetLimits(app, func(core.App) SendLimits { return SendLimits{PerHour: 5} })

	got := Limits(app)
	if got.PerHour != 5 {
		t.Errorf("PerHour = %d, want 5", got.PerHour)
	}
	if got.PerDay != 0 {
		t.Errorf("PerDay = %d, want 0 — a throttle must not imply a daily ceiling", got.PerDay)
	}
}
