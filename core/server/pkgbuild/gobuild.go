package pkgbuild

import (
	"path/filepath"
	"strings"
)

// buildServer compiles the server binary with `go build -v`, which names each
// package as it is compiled. Counted against the package total read up front,
// that moves the bar through [ProgGoBuild, ProgCLIBuild) instead of leaving it
// parked for the minute or more a cold compile takes.
func (p Pipeline) buildServer(sink ProgressSink, appDir, goDir string) error {
	var tags []string
	if len(p.GoBuildTags) > 0 {
		tags = []string{"-tags", strings.Join(p.GoBuildTags, ",")}
	}
	total := p.countGoPackages(sink, goDir, tags)

	compiled := 0
	throttle := newPnpmProgressThrottle()
	onLine := func(line string) {
		if !isGoPackageLine(line) {
			return
		}
		compiled++
		if !throttle.allow(p.now()) {
			return
		}
		frac := 0.0
		if total > 0 {
			frac = min(float64(compiled)/float64(total), 1)
		}
		ReportStepProgress(sink, stepServer, bandPct(ProgGoBuild, ProgCLIBuild, frac), int(frac*100),
			goBuildMessage(compiled, total))
	}

	// -o stays second: fakes in host tests recognise the server build by it.
	args := append([]string{"build", "-o", filepath.Join(appDir, p.binaryName()), "-v"}, tags...)
	args = append(args, ".")
	out, err := p.goStream()(onLine, goDir, "go", args...)
	if err != nil {
		// Same rationale as runPnpmInstall: in a confined builder the error
		// string is all that leaves the job child, so the compile errors must
		// ride it.
		return ErrFromCmd("go build", lastLines(out, 30), err)
	}
	sink.Logf("go build: %d packages compiled (%d in the build)", compiled, total)
	return nil
}

// countGoPackages is the number of packages `go build` may compile — every
// dependency of the main package under the same tags. 0 when it cannot be
// read; the bar then waits for the next step, and the message counts without
// a total. On a cold module cache this is also where the modules download.
func (p Pipeline) countGoPackages(sink ProgressSink, goDir string, tags []string) int {
	args := append(append([]string{"list", "-deps"}, tags...), ".")
	out, err := p.run()(goDir, "go", args...)
	if err != nil {
		sink.Logf("go list -deps failed (compile progress has no total): %v", err)
		return 0
	}
	n := 0
	for line := range strings.SplitSeq(out, "\n") {
		if isGoPackageLine(line) {
			n++
		}
	}
	return n
}

// isGoPackageLine reports whether a line of `go build -v` / `go list` output
// is an import path. Their other output — "go: downloading …", "# pkg"
// headers and compile errors — always holds a space or starts with '#'.
func isGoPackageLine(line string) bool {
	line = strings.TrimSpace(line)
	return line != "" && !strings.HasPrefix(line, "#") && !strings.ContainsAny(line, " \t")
}
