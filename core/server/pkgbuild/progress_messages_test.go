package pkgbuild

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFormatCount(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 4972: "4,972", 1234567: "1,234,567", -1312: "-1,312"} {
		if got := formatCount(n); got != want {
			t.Errorf("formatCount(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestPnpmLineMessage(t *testing.T) {
	cases := map[string]string{
		"Progress: resolved 1312, reused 2, downloaded 0, added 0": "1,312 packages found",
		"Packages: +1312": "Installing 1,312 packages",
		". postinstall$ tsx scripts/link-members.ts && cd tinycld && pnpm run packages:generate": "Setting up packages",
		". postinstall: Generated config for 9 feature package(s).":                              "Creating type definitions",
		"Done in 2m 27.3s using pnpm v11.3.0":                                                    "Packages installed",
		"WARN some deprecation":                                                                  "",
	}
	for line, want := range cases {
		if got := pnpmLineMessage(line); got != want {
			t.Errorf("pnpmLineMessage(%q) = %q, want %q", line, got, want)
		}
		// A line with words of its own must also move the bar, or it is never shown.
		if want != "" && pnpmLineProgress(line) == 0 {
			t.Errorf("pnpmLineProgress(%q) = 0 for a line with a message", line)
		}
	}
}

func TestExpoLineMessage(t *testing.T) {
	cases := map[string]string{
		"Web tinycld/index.js ▓▓▓▓▓▓▓░░░░░░░░░ 49.0% ( 829/1656)": "Bundling 829 of 1,656 files",
		"iOS tinycld/index.js ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░ 99.9% (5199/5199)": "Bundling 5,199 of 5,199 files",
		"Web Bundled 116250ms tinycld/index.js (4972 modules)":    "All files bundled",
		"Exported: dist": "Saving the bundle",
		"Web tinycld/index.js ░░░░░░░░░░░░░░░░  0.0% (0/1)": "Bundling 0 of 1 files",
		"Web tinycld/index.js 12.0% (no counts)":            "Bundling files",
	}
	for line, want := range cases {
		if got := expoLineMessage(line); got != want {
			t.Errorf("expoLineMessage(%q) = %q, want %q", line, got, want)
		}
	}
}

func TestGoBuildMessage(t *testing.T) {
	if got := goBuildMessage(312, 840); got != "Compiling 312 of 840 parts" {
		t.Errorf("with total: %q", got)
	}
	if got := goBuildMessage(1312, 0); got != "Compiled 1,312 parts" {
		t.Errorf("without total: %q", got)
	}
}

func TestCLITargetLabels(t *testing.T) {
	for _, target := range CLITargets {
		if target.Label() == target.Platform() {
			t.Errorf("%s has no label of its own", target.Platform())
		}
	}
	if got := cliTargetMessage(CLITargets[0], 0, len(CLITargets)); got != "macOS (Apple silicon), 1 of 5" {
		t.Errorf("cliTargetMessage = %q", got)
	}
}

func TestMemberAssembleMsg(t *testing.T) {
	if got := memberAssembleMsg(MemberSpec{Slug: "mail", Spec: "@tinycld/mail@1.2.0"}, 2, 9); got != "Downloading mail, 3 of 9" {
		t.Errorf("fetched member: %q", got)
	}
	if got := memberAssembleMsg(MemberSpec{Slug: "tinycld", FromCurrent: true}, 0, 9); got != "Reusing tinycld, 1 of 9" {
		t.Errorf("reused member: %q", got)
	}
}

// The server compile counts `go build -v` lines against `go list -deps`, so
// the bar climbs through its own band, and the person sees counts, not argv.
func TestBuildServer_ReportsCompileProgress(t *testing.T) {
	appDir := t.TempDir()
	now := time.Unix(0, 0)
	p := Pipeline{
		Now: func() time.Time {
			// Every line lands in a new throttle window.
			now = now.Add(time.Minute)
			return now
		},
		Run: func(dir, name string, args ...string) (string, error) {
			// go list -deps: four packages, plus noise that is not a package.
			return "go: downloading example.com/x v1.0.0\nfmt\nexample.com/x\nexample.com/y\nmain\n", nil
		},
		GoStream: func(onLine func(string), dir, name string, args ...string) (string, error) {
			for _, line := range []string{"example.com/x", "# example.com/y", "example.com/y"} {
				onLine(line)
			}
			return "", nil
		},
	}
	sink := &stepRecordingSink{}
	if err := p.buildServer(sink, appDir, filepath.Join(appDir, "server")); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"[60%] Building application: Compiling 1 of 4 parts",
		"[61%] Building application: Compiling 2 of 4 parts",
	}
	if strings.Join(sink.milestones, "\n") != strings.Join(want, "\n") {
		t.Fatalf("milestones:\n%s\nwant:\n%s", strings.Join(sink.milestones, "\n"), strings.Join(want, "\n"))
	}
	if sink.stepPercents[1] != 50 {
		t.Fatalf("step percent = %d, want 50", sink.stepPercents[1])
	}
}

// What every host shows is the step and its message. No message may carry a
// command line or raw tool output: those belong in the log.
func TestPipelineExecute_MessagesAreForPeople(t *testing.T) {
	build := mkCliDir(t)
	p := Pipeline{
		Run: func(dir, name string, args ...string) (string, error) { return "", nil },
		RunEnv: func(dir string, env []string, name string, args ...string) (string, error) {
			return "", nil
		},
		PnpmStream: func(onLine func(string), _, _ string, _ ...string) (string, error) {
			onLine("Progress: resolved 10, reused 0, downloaded 10, added 0")
			onLine("Packages: +10")
			onLine("Done in 3s using pnpm v11.3.0")
			return "", nil
		},
		ExpoStream: func(onLine func(string), _, _ string, _ ...string) (string, error) {
			onLine("Web tinycld/index.js ▓▓▓▓▓▓▓░░░░░░░░░ 49.0% (387/823)")
			onLine("Web Bundled 116250ms tinycld/index.js (4972 modules)")
			return "", nil
		},
		Stage:        func(appDir string) (string, error) { return filepath.Join(appDir, "r"), nil },
		NativeExport: func(ProgressSink, string, string, string) ([]BundleMeta, error) { return nil, nil },
	}
	sink := &stepRecordingSink{}
	if _, err := p.Execute(sink, build, "b"); err != nil {
		t.Fatal(err)
	}
	for _, m := range sink.milestones {
		for _, raw := range []string{"pnpm", "go build", "expo", "Progress:", "▓", "release-staging", "--platform"} {
			if strings.Contains(m, raw) {
				t.Errorf("milestone %q shows raw output %q", m, raw)
			}
		}
	}
	joined := strings.Join(sink.details, "\n")
	for _, raw := range []string{"pnpm: Packages: +10", "expo: Web Bundled"} {
		if !strings.Contains(joined, raw) {
			t.Errorf("log lost the raw line %q", raw)
		}
	}
}
