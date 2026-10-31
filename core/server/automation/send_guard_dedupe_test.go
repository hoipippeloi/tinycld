package automation

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// A second app's Register repeats the registration; the guard must still run
// once per check, not once per app.
func TestRegisterSendGuard_RepeatIsIgnored(t *testing.T) {
	ResetRegistriesForTest()
	t.Cleanup(ResetRegistriesForTest)
	calls := 0
	guard := func(core.App, *core.Record) (bool, string) {
		calls++
		return false, ""
	}
	RegisterSendGuard("zoo_messages", "zoo.loop-guard", guard)
	RegisterSendGuard("zoo_messages", "zoo.loop-guard", guard)

	col := core.NewBaseCollection("zoo_messages")
	if err := checkSendGuards(nil, core.NewRecord(col)); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("guard ran %d times, want 1", calls)
	}
}
