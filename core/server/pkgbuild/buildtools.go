package pkgbuild

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A rebuild compiles the TARGET release with the tools of the RUNNING install:
// the pnpm that corepack has cached and the Go toolchain on PATH. An install
// cannot change those tools itself (a container image keeps them in a
// read-only layer), so a target release that moves its pnpm or Go pin cannot be
// built in place. Without this check the build failed half-way through, at the
// first nested `pnpm run` or at `go build`, with a corepack cache-write error
// that did not say what to do.
//
// VerifyBuildTools runs, in the assembled build dir, the cheapest commands
// that resolve each tool the way the build will: `pnpm --version` in the base
// member (whose packageManager pin the generator's nested pnpm calls obey) and
// `go list -m` in the Go modules whose `go` line sets the workspace's
// toolchain. Each probe passes exactly when the build's own call would get its
// tool: a cached or downloadable pnpm, a local Go new enough or an allowed
// toolchain download. A failure names the tools and the release to deploy.
// run nil means RunCmdEnv.
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

	if len(missing) == 0 {
		return nil
	}
	release := "the new release"
	if v := PackageJSONVersion(filepath.Join(baseDir, "package.json")); v != "" {
		release = "tinycld v" + v
	}
	return fmt.Errorf(
		"this update needs build tools that this server does not have: %s. "+
			"An update cannot change the server's own build tools: deploy %s (a new image or binary), then try again",
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
	data, err := os.ReadFile(filepath.Join(baseDir, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	spec := strings.TrimPrefix(pkg.PackageManager, "pnpm@")
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
