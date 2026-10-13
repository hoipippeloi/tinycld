package pkgbuild

import (
	"fmt"
	"strconv"
	"strings"
)

// The wording a person waiting on a build sees. Every host shows these as they
// are: the step label names the stage, and the message (see ProgressSink) says
// where in it the build is. Tool output never reaches them.

const (
	stepClientDeps  = "Building client UI"
	stepServer      = "Building application"
	stepCLI         = "Building application tools"
	stepWebBundle   = "Packaging client UI"
	stepStage       = "Preparing client UI"
	stepNative      = "Building mobile app"
	stepNativeSkip  = "Skipping mobile app"
	stepBuildDone   = "Build finished"
	stepAssemble    = "Gathering components"
	msgNativeAbsent = "The mobile app keeps the version it was built with"
)

// formatCount writes n with thousands separators ("4,972"): the counts in a
// build's messages run into the thousands and read badly as one block.
func formatCount(n int) string {
	if n < 0 {
		return "-" + formatCount(-n)
	}
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// pnpmLineMessage says what a recognized pnpm line means for the person
// waiting, or "" for a line pnpmLineProgress does not recognize either.
func pnpmLineMessage(line string) string {
	switch {
	case strings.HasPrefix(line, "Progress:"):
		if n, ok := pnpmResolved(line); ok {
			return formatCount(n) + " packages found"
		}
		return "Finding packages"
	case strings.HasPrefix(line, "Packages: +"):
		if n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Packages: +"))); err == nil {
			return "Installing " + formatCount(n) + " packages"
		}
		return "Installing packages"
	case strings.Contains(line, "Generated config for"):
		// The generator is done; export-types (a Go compile) runs next.
		return "Creating type definitions"
	case strings.Contains(line, "packages:generate"):
		return "Setting up packages"
	case strings.HasPrefix(line, "Done in"):
		return "Packages installed"
	default:
		return ""
	}
}

// pnpmResolved reads N from pnpm's "Progress: resolved N, reused …" line.
func pnpmResolved(line string) (int, bool) {
	rest, ok := strings.CutPrefix(line, "Progress: resolved ")
	if !ok {
		return 0, false
	}
	num, _, _ := strings.Cut(rest, ",")
	n, err := strconv.Atoi(strings.TrimSpace(num))
	return n, err == nil
}

// expoLineMessage says what a Metro line means: the running file count while
// bundling, then the two terminal markers. "" for anything else.
func expoLineMessage(line string) string {
	switch {
	case strings.Contains(line, "Bundled "):
		return "All files bundled"
	case strings.HasPrefix(line, "Exported:"):
		return "Saving the bundle"
	}
	if done, total, ok := expoLineCounts(line); ok {
		return fmt.Sprintf("Bundling %s of %s files", formatCount(done), formatCount(total))
	}
	return "Bundling files"
}

// expoLineCounts reads "(n/total)" from a Metro progress line. Metro pads n
// with spaces ("( 829/1656)"), and total grows as it discovers files.
func expoLineCounts(line string) (int, int, bool) {
	_, rest, ok := strings.Cut(line, "% (")
	if !ok {
		return 0, 0, false
	}
	inner, _, ok := strings.Cut(rest, ")")
	if !ok {
		return 0, 0, false
	}
	a, b, ok := strings.Cut(inner, "/")
	if !ok {
		return 0, 0, false
	}
	done, err1 := strconv.Atoi(strings.TrimSpace(a))
	total, err2 := strconv.Atoi(strings.TrimSpace(b))
	if err1 != nil || err2 != nil || total <= 0 {
		return 0, 0, false
	}
	return done, total, true
}

// goBuildMessage counts the server compile. total is 0 when the package count
// could not be read up front.
func goBuildMessage(compiled, total int) string {
	if total <= 0 {
		return "Compiled " + formatCount(compiled) + " parts"
	}
	return fmt.Sprintf("Compiling %s of %s parts", formatCount(compiled), formatCount(total))
}

// cliTargetMessage names the platform being built and where it falls in the
// run ("macOS (Apple silicon), 1 of 5").
func cliTargetMessage(t CLITarget, i, n int) string {
	return fmt.Sprintf("%s, %d of %d", t.Label(), i+1, n)
}

// memberAssembleMsg is the progress message for materializing member i of n:
// downloaded for a changed member, reused from the running build otherwise.
func memberAssembleMsg(ms MemberSpec, i, n int) string {
	verb := "Downloading"
	if ms.FromCurrent {
		verb = "Reusing"
	}
	return fmt.Sprintf("%s %s, %d of %d", verb, ms.Slug, i+1, n)
}
