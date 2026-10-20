//go:build unix

package pkgbuild

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// killGroupOnCancel starts cmd as the leader of a new process group and makes
// its cancel SIGKILL that whole group, so the children a build tool started
// die with it.
//
// The new group also takes the command out of this process's group, so a
// signal to this process's group (the supervisor's SIGKILL) does not reach
// it. When this process dies without running the cancel, the command would
// outlive it; setParentDeathSignal covers that where the kernel can.
func killGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setParentDeathSignal(cmd.SysProcAttr)
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
