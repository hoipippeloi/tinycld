package appstate_test

import (
	"strings"
	"testing"

	"tinycld.org/core/appstate"
)

func TestScopedSeparatesApps(t *testing.T) {
	a, b := newApp(t), newApp(t)

	ka := appstate.Scoped(a, "card-1")
	kb := appstate.Scoped(b, "card-1")

	if ka == kb {
		t.Fatal("two apps got the same scoped key for one id")
	}
	if ka != appstate.Scoped(a, "card-1") {
		t.Fatal("Scoped is not stable for one app")
	}
	if !strings.HasSuffix(ka, "|card-1") || !strings.HasPrefix(ka, appstate.ID(a)) {
		t.Fatalf("Scoped = %q, want <ID>|card-1", ka)
	}
}
