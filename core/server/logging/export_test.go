package logging

import (
	"io"
	"log/slog"
)

// InstallTo installs a router whose stderr destination is w, and returns a
// func that restores the previous default.
func InstallTo(w io.Writer) func() {
	prev := slog.Default()
	slog.SetDefault(slog.New(newRouter(w)))
	return func() { slog.SetDefault(prev) }
}
