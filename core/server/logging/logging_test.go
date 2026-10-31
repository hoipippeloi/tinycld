package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestForPackageStampsThePkgAttr(t *testing.T) {
	var buf bytes.Buffer
	t.Cleanup(InstallTo(&buf))

	ForPackage("widgets").Warn("refusing to flush")

	out := buf.String()
	if !strings.Contains(out, "pkg=widgets") {
		t.Errorf("expected pkg=widgets, got %q", out)
	}
	if !strings.Contains(out, "refusing to flush") {
		t.Errorf("expected the message, got %q", out)
	}
}

func TestInstallSetsTheDefaultLogger(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	Install()
	if slog.Default().Handler() != slog.Handler(processRouter) {
		t.Fatalf("default handler = %T, want the process router", slog.Default().Handler())
	}
	installed := slog.Default()
	Install()
	if slog.Default() != installed {
		t.Fatal("a second Install replaced the installed default")
	}
}
