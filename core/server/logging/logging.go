package logging

import (
	"log/slog"
	"os"
)

// Destination levels. Independent by design: stderr and the DB-backed _logs
// table are for operators reading history, while Sentry is for paging someone.
//
// _logs has no level constant here — each app's own handler
// (app.Logger().Handler()) already gates itself on PocketBase's own
// admin-configurable Settings.Logs.MinLevel (Info by default). Wrapping it in
// a second, hardcoded filter would either duplicate that gate or silently
// override an admin who lowered MinLevel to Debug to troubleshoot — and
// _logs must keep receiving records unconditionally: the OTA e2e harness
// polls it for an "app-boot: rendered" beacon to confirm a promoted bundle
// booted on a device.
const (
	StderrLevel = slog.LevelInfo
	SentryLevel = slog.LevelWarn
)

// processRouter is the one handler Install puts in place. It holds no app:
// each record names its own through its ctx (WithApp), so every app in the
// process shares it.
var processRouter = newRouter(os.Stderr)

// Install sets the process-wide default logger to a handler that writes every
// record to stderr and Sentry, and to the _logs table of the app the record
// belongs to (see WithApp and SetDefaultApp). Safe to call again; a process
// that runs many apps installs it once for all of them.
func Install() {
	if slog.Default().Handler() == slog.Handler(processRouter) {
		return
	}
	slog.SetDefault(slog.New(processRouter))
}

// ForPackage returns a logger stamped with a pkg attribute, replacing the old
// hand-written "widgets: " message prefixes with a queryable structured field.
//
//	log := logging.ForPackage("widgets")
//	log.WarnContext(ctx, "refusing to flush a gadget from another widget", "gadgetID", id)
//
// The logger follows the default installed later by Install (see lazyHandler),
// so it is safe to create in a package-level var.
func ForPackage(name string) *slog.Logger {
	return slog.New(newLazyHandler(nil)).With("pkg", name)
}
