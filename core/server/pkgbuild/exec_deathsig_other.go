//go:build unix && !linux

package pkgbuild

import "syscall"

// setParentDeathSignal does nothing: darwin has no parent-death signal
// (Linux's PR_SET_PDEATHSIG, which SysProcAttr.Pdeathsig sets). FreeBSD has
// one, but no build of the server targets it. Here a build command in its
// own process group outlives this process when this process is killed
// without cancelling it. Servers run on Linux; on a development machine the
// command ends when it finishes, or when its next write to the closed output
// pipe fails.
func setParentDeathSignal(*syscall.SysProcAttr) {}
