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
func killGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
