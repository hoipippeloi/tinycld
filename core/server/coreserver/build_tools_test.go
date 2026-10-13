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

// fakeNode writes an executable `node` into dir that prints version.
func fakeNode(t *testing.T, dir, version string) {
	t.Helper()
	writeTestFile(t, filepath.Join(dir, "node"), "#!/bin/sh\necho "+version+"\n")
	if err := os.Chmod(filepath.Join(dir, "node"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func noLog(string, ...any) {}

// readOnlyCorepackHome builds an image-like corepack home holding pnpm
// 11.3.0 and lastKnownGood.json, made read-only.
func readOnlyCorepackHome(t *testing.T, lastKnownGood string) string {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root can write a 0555 directory")
	}
	home := t.TempDir()
	writeTestFile(t, filepath.Join(home, "v1", "pnpm", "11.3.0", "package.json"), `{}`)
	writeTestFile(t, filepath.Join(home, "lastKnownGood.json"), lastKnownGood)
	if err := os.Chmod(home, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(home, 0o755) })
	return home
}

// The image's corepack home is read-only to the runtime user: the server
// moves to a writable copy that keeps what the image had cached.
func TestUseWritableCorepackHome_MovesReadOnlyHome(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	t.Setenv("COREPACK_HOME", readOnlyCorepackHome(t, `{"pnpm":"11.3.0"}`))

	if err := useWritableCorepackHome(noLog); err != nil {
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

// Every start-up re-seeds from the image (the env does not survive a
// restart): a newer image's pnpm is copied in, a download already in the copy
// is kept, and lastKnownGood.json follows the image.
func TestUseWritableCorepackHome_ReseedKeepsDownloadsAndFollowsImage(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	writable := filepath.Join(stateToolchainsDir(), "corepack")
	writeTestFile(t, filepath.Join(writable, "v1", "pnpm", "12.9.1", "pnpm"), "download")
	writeTestFile(t, filepath.Join(writable, "v1", "pnpm", "11.3.0", "package.json"), "kept")
	writeTestFile(t, filepath.Join(writable, "lastKnownGood.json"), `{"pnpm":"12.9.1"}`)
	t.Setenv("COREPACK_HOME", readOnlyCorepackHome(t, `{"pnpm":"11.3.0"}`))

	if err := useWritableCorepackHome(noLog); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		filepath.Join("v1", "pnpm", "12.9.1", "pnpm"):         "download",
		filepath.Join("v1", "pnpm", "11.3.0", "package.json"): "kept",
		"lastKnownGood.json":                                  `{"pnpm":"11.3.0"}`,
	} {
		if got, err := os.ReadFile(filepath.Join(writable, path)); err != nil || string(got) != want {
			t.Errorf("%s = %q, %v; want %q", path, got, err, want)
		}
	}
}

func TestUseWritableCorepackHome_LeavesWritableHome(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	home := t.TempDir()
	t.Setenv("COREPACK_HOME", home)
	if err := useWritableCorepackHome(noLog); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("COREPACK_HOME"); got != home {
		t.Fatalf("COREPACK_HOME = %s, want it unchanged (%s)", got, home)
	}
	if _, err := os.Stat(stateToolchainsDir()); !os.IsNotExist(err) {
		t.Fatal("a writable home must not be copied")
	}
}

// nodeBuild is an assembled build whose base member declares engines.node.
func nodeBuild(t *testing.T, engines string) string {
	t.Helper()
	buildDir := t.TempDir()
	writeTestFile(t, filepath.Join(buildDir, baseMemberSlug, "package.json"), `{"engines":{"node":"`+engines+`"}}`)
	return buildDir
}

// cachedNode leaves an earlier download at nodeCurrentDir printing version.
func cachedNode(t *testing.T, version string) {
	t.Helper()
	fakeNode(t, filepath.Join(stateToolchainsDir(), "node", version, "bin"), version)
	if err := os.Symlink(version, nodeCurrentDir()); err != nil {
		t.Fatal(err)
	}
}

// A newer image's Node wins over an older download left in the state volume,
// and a download put on PATH by an earlier build is taken off again.
func TestEnsureNode_ImageNodeWinsOverOldDownload(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	imageBin := t.TempDir()
	fakeNode(t, imageBin, "v24.1.0")
	cachedNode(t, "v22.12.0")
	cachedBin := filepath.Join(nodeCurrentDir(), "bin")
	t.Setenv("PATH", cachedBin+string(os.PathListSeparator)+imageBin)

	if err := ensureNode(noLog, nodeBuild(t, ">=22")); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("PATH"); got != imageBin {
		t.Fatalf("PATH = %s, want only the image's %s", got, imageBin)
	}
}

// An image Node below the range uses the earlier download, with no network.
func TestEnsureNode_UsesEarlierDownloadWhenImageIsTooOld(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	imageBin := t.TempDir()
	fakeNode(t, imageBin, "v20.18.0")
	cachedNode(t, "v22.12.0")
	t.Setenv("PATH", imageBin)

	if err := ensureNode(noLog, nodeBuild(t, ">=22")); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(nodeCurrentDir(), "bin") + string(os.PathListSeparator) + imageBin
	if got := os.Getenv("PATH"); got != want {
		t.Fatalf("PATH = %s, want %s", got, want)
	}
}

func TestEnsureNode_NoEnginesRangeDoesNothing(t *testing.T) {
	t.Setenv("TINYCLD_STATE_DIR", t.TempDir())
	buildDir, _ := laneBuild(t, "3.0.0", "3.0.0")
	if err := ensureNode(noLog, buildDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stateToolchainsDir(), "node")); !os.IsNotExist(err) {
		t.Fatal("no engines.node range: nothing may be fetched")
	}
}
