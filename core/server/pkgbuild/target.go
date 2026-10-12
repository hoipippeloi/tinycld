package pkgbuild

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// RuntimeVersion is the native runtime lane of the app at appDir (the
// runtimeVersion its OTA bundles carry). A store binary loads only bundles of
// its own lane.
func RuntimeVersion(appDir string) string {
	return appVersionFromManifest(appDir)
}

// AdoptTargetPins replaces the build's version pins with the target base
// member's own table (tinycld/core/package-versions.json) and re-renders the
// pnpm overrides block from it.
//
// A build normally keeps the ACTIVE build's pins (see OverridesFile), because
// its OTA bundles go to store binaries compiled against those versions. That
// only holds inside one runtime lane. When the target moves to a new lane, its
// bundles go only to the new lane's binaries, and its code needs its own
// framework versions; frozen pins would compile it against the old ones. Call
// this only for a build whose RuntimeVersion differs from the active build's.
func AdoptTargetPins(buildDir string, members []string, opts ScaffoldOptions) error {
	src := filepath.Join(buildDir, BaseMemberSlug, "core", OverridesFile)
	raw, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read target pins: %w", err)
	}
	if err := os.WriteFile(filepath.Join(buildDir, OverridesFile), raw, 0o644); err != nil {
		return fmt.Errorf("write target pins: %w", err)
	}
	return writePnpmWorkspaceYAML(buildDir, members, opts.storeDir())
}

// AdoptTargetPackageManager sets the assembled root's packageManager to the
// target base member's pin. The root is written with this binary's
// PackageManagerSpec, but the generator's nested `cd tinycld && pnpm run …`
// resolves pnpm from the member's pin, so a target that moves pnpm would
// otherwise run two pnpm versions in one install. A base member with no pin
// leaves the root unchanged.
func AdoptTargetPackageManager(buildDir string) error {
	spec := basePackageManager(filepath.Join(buildDir, BaseMemberSlug))
	if spec == "" {
		return nil
	}
	rootPath := filepath.Join(buildDir, "package.json")
	raw, err := os.ReadFile(rootPath)
	if err != nil {
		return err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return fmt.Errorf("parse root package.json: %w", err)
	}
	root["packageManager"] = spec
	b, err := json.MarshalIndent(root, "", "    ")
	if err != nil {
		return err
	}
	return os.WriteFile(rootPath, append(b, '\n'), 0o644)
}

// basePackageManager is the full packageManager spec ("pnpm@12.9.1+sha512.…")
// of the package.json in dir, or "" if absent or unreadable.
func basePackageManager(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	return pkg.PackageManager
}
