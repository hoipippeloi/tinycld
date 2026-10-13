package pkgbuild

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeToolsBuild lays out the base member files VerifyBuildTools reads: the
// base package.json (version + pnpm pin) and core's server go.mod.
func writeToolsBuild(t *testing.T, goLine string) string {
	t.Helper()
	buildDir := t.TempDir()
	base := filepath.Join(buildDir, BaseMemberSlug)
	coreServer := filepath.Join(base, "core", "server")
	if err := os.MkdirAll(coreServer, 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"tinycld","version":"0.7.0","packageManager":"pnpm@12.9.1+sha512.abc"}`
	if err := os.WriteFile(filepath.Join(base, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	mod := "module tinycld.org/core\n\ngo " + goLine + "\n"
	if err := os.WriteFile(filepath.Join(coreServer, "go.mod"), []byte(mod), 0o644); err != nil {
		t.Fatal(err)
	}
	return buildDir
}

// stubNodeVersion is what the stub answers to `node --version`.
var stubNodeVersion = "v20.18.0\n"

// stubPnpm answers the pnpm probe with pnpmErr and runs go for real, so the
// Go half exercises the actual toolchain check.
func stubPnpm(pnpmOut string, pnpmErr error, calls *[]string) CmdEnvRunner {
	return func(dir string, env []string, name string, args ...string) (string, error) {
		*calls = append(*calls, dir+"|"+strings.Join(env, ",")+"|"+name+" "+strings.Join(args, " "))
		switch name {
		case "pnpm":
			return pnpmOut, pnpmErr
		case "node":
			return stubNodeVersion, nil
		}
		return RunCmdEnv(dir, env, name, args...)
	}
}

func TestVerifyBuildTools_PassesWhenToolsResolve(t *testing.T) {
	buildDir := writeToolsBuild(t, "1.21")
	var calls []string
	if err := VerifyBuildTools(buildDir, stubPnpm("12.9.1", nil, &calls)); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	base := filepath.Join(buildDir, BaseMemberSlug)
	want := []string{
		base + "|" + ServerRebuildEnv + ",TINYCLD_WS_ROOT=" + buildDir + "|pnpm --version",
		filepath.Join(base, "core", "server") + "|GOWORK=off|go list -m",
	}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("probes =\n%s\nwant\n%s", strings.Join(calls, "\n"), strings.Join(want, "\n"))
	}
}

// The tinycld.org failure: the image's corepack cache is read-only, so the
// target's pnpm pin cannot be fetched.
func TestVerifyBuildTools_MissingPnpmNamesVersionAndRelease(t *testing.T) {
	buildDir := writeToolsBuild(t, "1.21")
	var calls []string
	out := "Failed to create cache directory. Please ensure the user has write access to the target directory (/opt/corepack/v1)."
	err := VerifyBuildTools(buildDir, stubPnpm(out, errors.New("exit status 1"), &calls))
	if err == nil {
		t.Fatal("expected the pnpm probe failure to refuse the build")
	}
	for _, want := range []string{"pnpm 12.9.1", "/opt/corepack/v1", "deploy tinycld v0.7.0"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error should contain %q, got: %v", want, err)
		}
	}
}

// A real `go` that is older than the target's `go` line, with downloads
// disabled, fails exactly as `go build` would.
func TestVerifyBuildTools_GoTooOldNamesRequiredVersion(t *testing.T) {
	t.Setenv("GOTOOLCHAIN", "local")
	buildDir := writeToolsBuild(t, "1.999.0")
	var calls []string
	err := VerifyBuildTools(buildDir, stubPnpm("12.9.1", nil, &calls))
	if err == nil {
		t.Fatal("expected a go toolchain older than go 1.999.0 to refuse the build")
	}
	for _, want := range []string{"go 1.999.0", "requires go >= 1.999.0", "deploy tinycld v0.7.0"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error should contain %q, got: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "pnpm") {
		t.Fatalf("pnpm resolved, so the error must not name it: %v", err)
	}
}

func TestRequiredPnpm_StripsIntegrity(t *testing.T) {
	buildDir := writeToolsBuild(t, "1.21")
	if got := requiredPnpm(filepath.Join(buildDir, BaseMemberSlug)); got != "12.9.1" {
		t.Fatalf("requiredPnpm = %q, want 12.9.1", got)
	}
}

// The node probe compares `node --version` with the target's engines.node.
func TestVerifyBuildTools_NodeBelowEnginesRange(t *testing.T) {
	buildDir := writeToolsBuild(t, "1.21")
	writeFile(t, filepath.Join(buildDir, BaseMemberSlug, "package.json"),
		`{"version":"0.7.0","packageManager":"pnpm@12.9.1+sha512.abc","engines":{"node":">=22"}}`)
	var calls []string
	err := VerifyBuildTools(buildDir, stubPnpm("12.9.1", nil, &calls))
	if err == nil {
		t.Fatal("expected node v20.18.0 to fail engines.node >=22")
	}
	for _, want := range []string{"node >=22", "found v20.18.0"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error should contain %q, got: %v", want, err)
		}
	}

	stubNodeVersion = "v22.12.0\n"
	defer func() { stubNodeVersion = "v20.18.0\n" }()
	if err := VerifyBuildTools(buildDir, stubPnpm("12.9.1", nil, &calls)); err != nil {
		t.Fatalf("node v22.12.0 satisfies >=22, got %v", err)
	}
}
