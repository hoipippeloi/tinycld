package pkgbuild

import "syscall"

// setParentDeathSignal makes the kernel SIGKILL the command when this
// process dies without cancelling it (SIGKILL from the supervisor, the OOM
// killer), so a build command in its own process group does not outlive the
// server that started it.
//
// The signal is tied to the thread that started the command, not to the
// process: Linux sends it when that thread exits. The Go runtime ends a
// thread only when a goroutine locked to it (runtime.LockOSThread) exits
// without unlocking; it keeps every other thread until the process exits.
// No caller starts a command from a locked goroutine, so here the signal
// comes only when the process dies. A caller that locks its goroutine must
// keep it locked, and alive, until the command has been reaped (as the
// supervisor's child.run does), or the command is killed when it exits.
//
// It does not interfere with Setpgid: the death signal goes to the command
// alone, whatever its group, and the cancel still kills the whole group.
// The command's own children (pnpm's node) are not covered. They lose their
// output pipe with this process, so most end at their next write; a later
// cancel of the group cannot reach them once this process is gone.
func setParentDeathSignal(attr *syscall.SysProcAttr) {
	attr.Pdeathsig = syscall.SIGKILL
}
