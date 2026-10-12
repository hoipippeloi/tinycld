package coreserver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tinycld.org/core/installjob"
	"tinycld.org/core/pkgbuild"
)

func writeTestFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// laneBuild lays out an assembled build whose base member is on runtime lane
// targetLane, with the active build's frozen pins at the root, plus an active
// app dir on activeLane.
func laneBuild(t *testing.T, activeLane, targetLane string) (buildDir, activeAppDir string) {
	t.Helper()
	buildDir = t.TempDir()
	activeAppDir = t.TempDir()
	writeTestFile(t, filepath.Join(activeAppDir, "app.json"), `{"expo":{"version":"`+activeLane+`"}}`)
	base := filepath.Join(buildDir, baseMemberSlug)
	writeTestFile(t, filepath.Join(base, "app.json"), `{"expo":{"version":"`+targetLane+`"}}`)
	writeTestFile(t, filepath.Join(base, "package.json"), `{"packageManager":"pnpm@12.9.1+sha512.abc"}`)
	writeTestFile(t, filepath.Join(base, "core", pkgbuild.OverridesFile), `{"expo":"57.0.27"}`)
	writeTestFile(t, filepath.Join(buildDir, pkgbuild.OverridesFile), `{"expo":"55.0.26"}`)
	writeTestFile(t, filepath.Join(buildDir, "package.json"), `{"name":"@tinycld/workspace","packageManager":"pnpm@11.3.0"}`)
	return buildDir, activeAppDir
}

func laneManifest() RebuildManifest {
	return RebuildManifest{BuildID: "b", Members: []MemberSpec{{Slug: baseMemberSlug}, {Slug: "mail"}}}
}

func TestAdoptTargetScaffold_NewLaneTakesTargetPins(t *testing.T) {
	buildDir, active := laneBuild(t, "3.0.0", "3.1.0")
	if err := adoptTargetScaffold(&installjob.Job{ID: "j"}, laneManifest(), buildDir, active); err != nil {
		t.Fatal(err)
	}
	pins, err := pkgbuild.ReadOverrides(buildDir)
	if err != nil || pins["expo"] != "57.0.27" {
		t.Fatalf("pins = %v, %v; a new lane must take the target's expo 57.0.27", pins, err)
	}
	root, _ := os.ReadFile(filepath.Join(buildDir, "package.json"))
	if !strings.Contains(string(root), "pnpm@12.9.1") {
		t.Fatalf("root must take the target's pnpm pin:\n%s", root)
	}
}

// Inside one lane the OTA bundles go to the same store binaries, so the
// active build's pins stay. The pnpm pin follows the target either way.
func TestAdoptTargetScaffold_SameLaneKeepsFrozenPins(t *testing.T) {
	buildDir, active := laneBuild(t, "3.1.0", "3.1.0")
	if err := adoptTargetScaffold(&installjob.Job{ID: "j"}, laneManifest(), buildDir, active); err != nil {
		t.Fatal(err)
	}
	pins, err := pkgbuild.ReadOverrides(buildDir)
	if err != nil || pins["expo"] != "55.0.26" {
		t.Fatalf("pins = %v, %v; the same lane must keep the active expo 55.0.26", pins, err)
	}
	root, _ := os.ReadFile(filepath.Join(buildDir, "package.json"))
	if !strings.Contains(string(root), "pnpm@12.9.1") {
		t.Fatalf("root must take the target's pnpm pin:\n%s", root)
	}
}

// An unreadable lane on either side is treated as the same lane.
func TestAdoptTargetScaffold_UnknownLaneKeepsFrozenPins(t *testing.T) {
	buildDir, _ := laneBuild(t, "3.0.0", "3.1.0")
	if err := adoptTargetScaffold(&installjob.Job{ID: "j"}, laneManifest(), buildDir, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if pins, _ := pkgbuild.ReadOverrides(buildDir); pins["expo"] != "55.0.26" {
		t.Fatalf("pins = %v; an unknown active lane must keep the frozen pins", pins)
	}
}

// The image's corepack home is read-only to the runtime user: the build moves
// to a writable copy that keeps what the image had cached.
func TestUseToolchainEnv_MovesReadOnlyCorepackHome(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write a 0555 directory")
	}
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	imageHome := t.TempDir()
	writeTestFile(t, filepath.Join(imageHome, "v1", "pnpm", "11.3.0", "package.json"), `{}`)
	if err := os.Chmod(imageHome, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(imageHome, 0o755) })
	t.Setenv("COREPACK_HOME", imageHome)

	if err := useToolchainEnv(&installjob.Job{ID: "j"}); err != nil {
		t.Fatal(err)
	}
	moved := os.Getenv("COREPACK_HOME")
	if moved != filepath.Join(stateToolchainsDir(), "corepack") {
		t.Fatalf("COREPACK_HOME = %s, want the writable copy", moved)
	}
	if _, err := os.Stat(filepath.Join(moved, "v1", "pnpm", "11.3.0", "package.json")); err != nil {
		t.Fatalf("the copy must keep the image's cached pnpm: %v", err)
	}
	if !dirWritable(moved) {
		t.Fatal("the new corepack home must be writable")
	}
}

func TestUseToolchainEnv_LeavesWritableCorepackHome(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	home := t.TempDir()
	t.Setenv("COREPACK_HOME", home)
	if err := useToolchainEnv(&installjob.Job{ID: "j"}); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("COREPACK_HOME"); got != home {
		t.Fatalf("COREPACK_HOME = %s, want it unchanged (%s)", got, home)
	}
}

// A Node fetched by an earlier build goes first on PATH for this one.
func TestUseToolchainEnv_PutsFetchedNodeFirstOnPath(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	t.Setenv("COREPACK_HOME", "")
	t.Setenv("PATH", "/usr/bin")
	writeTestFile(t, filepath.Join(stateToolchainsDir(), "node", "v22.12.0", "bin", "node"), "")
	if err := os.Symlink("v22.12.0", nodeCurrentDir()); err != nil {
		t.Fatal(err)
	}
	if err := useToolchainEnv(&installjob.Job{ID: "j"}); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(nodeCurrentDir(), "bin") + string(os.PathListSeparator) + "/usr/bin"
	if got := os.Getenv("PATH"); got != want {
		t.Fatalf("PATH = %s, want %s", got, want)
	}
	// Idempotent: a second build does not stack the entry.
	if err := useToolchainEnv(&installjob.Job{ID: "j"}); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("PATH"); got != want {
		t.Fatalf("PATH after a second call = %s, want %s", got, want)
	}
}

func TestEnsureNode_NoEnginesRangeDoesNothing(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	buildDir, _ := laneBuild(t, "3.0.0", "3.0.0")
	if err := ensureNode(&installjob.Job{ID: "j"}, buildDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stateToolchainsDir(), "node")); !os.IsNotExist(err) {
		t.Fatal("no engines.node range: nothing may be fetched")
	}
}
