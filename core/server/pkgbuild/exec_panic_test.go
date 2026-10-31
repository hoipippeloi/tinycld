package pkgbuild

import (
	"context"
	"strings"
	"testing"
)

// The scanner must keep draining the pipe after a callback panics, or the
// subprocess blocks on its next write and the build never ends.
func TestRunCmdStreaming_CallbackPanicDoesNotStopTheScan(t *testing.T) {
	var seen []string
	onLine := func(line string) {
		if line == "first" {
			panic("progress callback exploded")
		}
		seen = append(seen, line)
	}

	out, err := RunCmdStreamingEnvContext(context.Background(), onLine, t.TempDir(), nil,
		"sh", "-c", "echo first; echo second")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "second") || len(seen) != 1 || seen[0] != "second" {
		t.Fatalf("out = %q, seen = %v; want the line after the panic", out, seen)
	}
}
