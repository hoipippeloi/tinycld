package pkgbuild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A build on a new runtime lane takes the target's own framework table: both
// the root pins file and the overrides block pnpm reads.
func TestAdoptTargetPins_ReplacesPinsAndOverrides(t *testing.T) {
	buildDir := t.TempDir()
	writeFile(t, filepath.Join(buildDir, OverridesFile), `{"//":"active","expo":"55.0.26"}`)
	writeFile(t, filepath.Join(buildDir, BaseMemberSlug, "core", OverridesFile), `{"//":"target","expo":"57.0.27"}`)

	if err := AdoptTargetPins(buildDir, []string{BaseMemberSlug, "mail"}, ScaffoldOptions{}); err != nil {
		t.Fatal(err)
	}
	pins, err := readOverrides(buildDir)
	if err != nil || pins["expo"] != "57.0.27" {
		t.Fatalf("root pins = %v, %v; want expo 57.0.27", pins, err)
	}
	yaml, err := os.ReadFile(filepath.Join(buildDir, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(yaml), "57.0.27") || strings.Contains(string(yaml), "55.0.26") {
		t.Fatalf("overrides block must carry the target's expo pin only:\n%s", yaml)
	}
	if !strings.Contains(string(yaml), "  - mail\n") {
		t.Fatalf("pnpm-workspace.yaml lost the member list:\n%s", yaml)
	}
}

func TestAdoptTargetPackageManager(t *testing.T) {
	buildDir := t.TempDir()
	if err := writeRootPackageJSON(buildDir, []string{BaseMemberSlug}); err != nil {
		t.Fatal(err)
	}
	target := "pnpm@99.0.0+sha512.abc"
	writeFile(t, filepath.Join(buildDir, BaseMemberSlug, "package.json"), `{"packageManager":"`+target+`"}`)

	if err := AdoptTargetPackageManager(buildDir); err != nil {
		t.Fatal(err)
	}
	var root map[string]any
	raw, _ := os.ReadFile(filepath.Join(buildDir, "package.json"))
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatal(err)
	}
	if root["packageManager"] != target {
		t.Fatalf("root packageManager = %v, want %s", root["packageManager"], target)
	}
	if root["scripts"] == nil || root["workspaces"] == nil {
		t.Fatalf("root package.json lost its other fields: %v", root)
	}
}

// A base member without a pin keeps the root's own spec.
func TestAdoptTargetPackageManager_NoPinKeepsRoot(t *testing.T) {
	buildDir := t.TempDir()
	if err := writeRootPackageJSON(buildDir, []string{BaseMemberSlug}); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(buildDir, BaseMemberSlug, "package.json"), `{"name":"tinycld"}`)
	if err := AdoptTargetPackageManager(buildDir); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(buildDir, "package.json"))
	if !strings.Contains(string(raw), PackageManagerSpec) {
		t.Fatalf("root must keep %s:\n%s", PackageManagerSpec, raw)
	}
}
