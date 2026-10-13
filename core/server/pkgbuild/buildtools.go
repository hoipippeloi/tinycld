package pkgbuild

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// VerifyBuildTools checks, in the assembled build dir, that each tool the
// target release pins resolves the way the build will resolve it. It runs the
// cheapest command per tool: `pnpm --version` in the base member (whose
// packageManager pin the generator's nested pnpm calls obey), `go list -m` in
// the Go modules whose `go` line sets the workspace's toolchain, and
// `node --version` against the base member's engines.node range. Each probe
// passes exactly when the build's own call would get its tool, so a host that
// fetches tools first (a writable corepack home, GOTOOLCHAIN=auto, a
// downloaded Node) calls this after that step as the final word. A failure
// names each tool, the reason, and the release to deploy when the tools cannot
// be fetched. run nil means RunCmdEnv.
func VerifyBuildTools(buildDir string, run CmdEnvRunner) error {
	if run == nil {
		run = RunCmdEnv
	}
	baseDir := filepath.Join(buildDir, BaseMemberSlug)
	var missing []string

	if out, err := run(baseDir, childEnv(buildDir), "pnpm", "--version"); err != nil {
		missing = append(missing, fmt.Sprintf("pnpm %s (%s)", requiredPnpm(baseDir), probeDetail(out, err)))
	}

	// GOWORK=off: the build's go.work is written later by the generator, from
	// core's `go` line. Checking each module on its own reads the same line.
	for _, rel := range []string{filepath.Join("core", "server"), "server"} {
		modDir := filepath.Join(baseDir, rel)
		if _, err := os.Stat(filepath.Join(modDir, "go.mod")); err != nil {
			continue
		}
		if out, err := run(modDir, []string{"GOWORK=off"}, "go", "list", "-m"); err != nil {
			missing = append(missing, fmt.Sprintf("go %s (%s)", requiredGo(modDir), probeDetail(out, err)))
			break
		}
	}

	if want := RequiredNode(buildDir); want != "" {
		out, err := run(baseDir, nil, "node", "--version")
		if err != nil {
			missing = append(missing, fmt.Sprintf("node %s (%s)", want, probeDetail(out, err)))
		} else if ok, cerr := NodeSatisfies(out, want); cerr != nil || !ok {
			detail := "found " + strings.TrimSpace(out)
			if cerr != nil {
				detail = cerr.Error()
			}
			missing = append(missing, fmt.Sprintf("node %s (%s)", want, detail))
		}
	}

	if len(missing) == 0 {
		return nil
	}
	release := "the new release"
	if v := PackageJSONVersion(filepath.Join(baseDir, "package.json")); v != "" {
		release = "tinycld v" + v
	}
	return fmt.Errorf(
		"this update needs build tools that this server could not get: %s. "+
			"Check that the server can reach the internet, or deploy %s (a new image or binary), then try again",
		strings.Join(missing, "; "), release)
}

// probeDetail is the end of a failed probe's output on one line (the tool's
// own reason), or the run error when the probe printed nothing.
func probeDetail(out string, err error) string {
	if tail := strings.TrimSpace(lastLines(strings.TrimSpace(out), 2)); tail != "" {
		return strings.ReplaceAll(tail, "\n", " | ")
	}
	return err.Error()
}

// requiredPnpm is the pnpm version the base member pins, without the
// integrity suffix ("pnpm@12.9.1+sha512.…" → "12.9.1"), or "" if unreadable.
func requiredPnpm(baseDir string) string {
	spec := strings.TrimPrefix(basePackageManager(baseDir), "pnpm@")
	version, _, _ := strings.Cut(spec, "+")
	return version
}

var goDirective = regexp.MustCompile(`(?m)^go\s+(\S+)`)

// requiredGo is the `go` line of the module at modDir, or "" if unreadable.
func requiredGo(modDir string) string {
	data, err := os.ReadFile(filepath.Join(modDir, "go.mod"))
	if err != nil {
		return ""
	}
	if m := goDirective.FindSubmatch(data); m != nil {
		return string(m[1])
	}
	return ""
}
