//go:build !unix

package pkgbuild

import "os/exec"

// killGroupOnCancel keeps exec.CommandContext's own cancel, which kills only
// the direct child: process groups are a unix concept.
func killGroupOnCancel(*exec.Cmd) {}
