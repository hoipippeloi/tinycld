package ratelimit

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
)

func newPerAppTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestPerAppBudgetsAreSeparate(t *testing.T) {
	limiter := NewPerApp("ratelimit_test.login", 2, time.Minute)
	a, b := newPerAppTestApp(t), newPerAppTestApp(t)

	if !limiter.For(a).Allow("203.0.113.1") || !limiter.For(a).Allow("203.0.113.1") {
		t.Fatal("app A: the first two events were refused")
	}
	if limiter.For(a).Allow("203.0.113.1") {
		t.Fatal("app A: the third event slipped past the limit")
	}
	if !limiter.For(b).Allow("203.0.113.1") {
		t.Fatal("app B was charged for app A's events")
	}
}

func TestPerAppReturnsOneLimiterPerApp(t *testing.T) {
	limiter := NewPerApp("ratelimit_test.same", 1, time.Minute)
	a := newPerAppTestApp(t)

	if limiter.For(a) != limiter.For(a) {
		t.Fatal("For made a second limiter for the same app")
	}
}
