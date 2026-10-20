package pkgbuild

import (
	"context"
	"syscall"
	"testing"
)

// A build command in its own process group must still die with the server
// when the server is killed without cancelling it.
func TestCommandContext_SetsTheParentDeathSignal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := commandContext(ctx, "true")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("the command does not run in its own process group")
	}
	if cmd.SysProcAttr.Pdeathsig != syscall.SIGKILL {
		t.Fatalf("Pdeathsig = %v, want SIGKILL", cmd.SysProcAttr.Pdeathsig)
	}
}
