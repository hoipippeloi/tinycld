package readonly

import (
	"testing"
)

func TestOnEnterRunsBeforeEnterReturns(t *testing.T) {
	app := bareApp(t)

	ran := false
	OnEnter(app, func() {
		if !Active(app) {
			t.Error("the hook ran before the mode was active")
		}
		ran = true
	})
	Enter(app)
	if !ran {
		t.Fatal("the hook did not run before Enter returned")
	}
}
