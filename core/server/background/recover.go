package background

import (
	"context"
	"fmt"
	"runtime/debug"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
	"tinycld.org/core/logging"
)

// Recover ends a panic in the calling goroutine and logs it, with its stack,
// against app. Defer it as the first statement of a goroutine that does one
// app's work but that Jobs.Run does not start (a ticker loop, a timer
// callback, a fan-out worker):
//
//	go func() {
//		defer background.Recover(app, "widgets", "widget sweep")
//		...
//	}()
//
// A panic that no recover stops ends the process, and with it every app the
// process runs.
func Recover(app core.App, pkg, name string) {
	r := recover()
	if r == nil {
		return
	}
	logging.ForPackage(pkg).ErrorContext(logging.WithApp(context.Background(), app),
		"goroutine panicked",
		"app", appstate.ID(app), "job", name, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
}
