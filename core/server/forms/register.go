package forms

import (
	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("forms")

// registerCore binds every hook on a core.App. Register (Task 10) wraps it
// for the real server; tests call it on a tests.TestApp.
func registerCore(app core.App, defs *Defs) {
	if len(defs.Hosts) == 0 {
		return
	}
	bindFormsHooks(app, defs)
}
