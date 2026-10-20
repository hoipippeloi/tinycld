package coreserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"tinycld.org/core/installjob"
	"tinycld.org/core/pkgbuild"
)

// The assemble step itself lives in pkgbuild/assemble.go. What stays here is
// the standalone host's MemberSource: fetch via npm pack, and — the part
// only this host can do — copy unchanged members out of the currently-active
// build.

// currentWorkspaceRoot returns the workspace root of the running build: the
// binary lives at <root>/tinycld/tinycld, so resolveServerDir() == <root>/tinycld
// and its parent is the root.
func currentWorkspaceRoot() string {
	return filepath.Dir(resolveServerDir())
}

// hostMemberSource is the standalone MemberSource: changed members are
// fetched with the standard npm-pack source, unchanged (FromCurrent) members
// are copied from the live build. ctx bounds the fetch's commands.
type hostMemberSource struct{ ctx context.Context }

var _ pkgbuild.MemberSource = hostMemberSource{}

func (s hostMemberSource) Fetch(ms MemberSpec, buildDir string) (string, error) {
	return pkgbuild.NpmPackSourceContext(s.ctx).Fetch(ms, buildDir)
}

func (hostMemberSource) CopyCurrent(ms MemberSpec, buildDir string) (string, error) {
	return copyMemberFromCurrent(ms, buildDir)
}

// copyMemberFromCurrent copies an unchanged member from the live build's
// workspace root (the parent of resolveServerDir(), i.e. /workspace/current/..)
// into buildDir. This keeps unchanged members byte-identical to what's running
// instead of re-fetching (which could drift their spec below the running
// version and drop migrations the running build ships).
//
// The member's integrity is carried forward from the active build's
// members.lock.json — the bytes are the same bytes that lock recorded. "" when
// the active build predates the lock file; RecipeHash refuses such a set, and
// the next fetched build repopulates it.
func copyMemberFromCurrent(ms MemberSpec, buildDir string) (string, error) {
	src := filepath.Join(currentWorkspaceRoot(), ms.Slug)
	if _, err := os.Stat(src); err != nil {
		// The current build doesn't carry this member (shouldn't happen for an
		// unchanged member). Surface it rather than silently producing a broken
		// build — the caller fails the rebuild.
		return "", fmt.Errorf("current build missing member %q at %s: %w", ms.Slug, src, err)
	}
	dest := filepath.Join(buildDir, ms.Slug)
	if err := os.RemoveAll(dest); err != nil {
		return "", err
	}
	if err := copyDir(src, dest); err != nil {
		return "", err
	}
	return pkgbuild.LockedIntegrity(currentWorkspaceRoot(), ms.Slug), nil
}

// assembleBuild materializes the desired member set into buildDir. Kept as the
// host-side wrapper so the production wiring reads at one glance: the job's
// progress sink (install-log row + durable log), the host MemberSource, and
// the active root as the scaffold source.
func assembleBuild(ctx context.Context, job *installjob.Job, m RebuildManifest, buildDir string) error {
	if err := pkgbuild.AssembleBuildContext(ctx, installJobSink{job}, m, buildDir,
		hostMemberSource{ctx: ctx}, currentWorkspaceRoot(), pkgbuild.ScaffoldOptions{}); err != nil {
		return err
	}
	return adoptTargetScaffold(job, m, buildDir, resolveServerDir())
}

// adoptTargetScaffold takes from the target what the scaffold copied from the
// active build but the target may have changed: its pnpm pin always, and its
// framework version pins when it moves to a new native runtime lane (see
// pkgbuild.AdoptTargetPins). activeAppDir is the running build's app dir.
func adoptTargetScaffold(job *installjob.Job, m RebuildManifest, buildDir, activeAppDir string) error {
	if err := pkgbuild.AdoptTargetPackageManager(buildDir); err != nil {
		return fmt.Errorf("adopt target pnpm pin: %w", err)
	}
	active := pkgbuild.RuntimeVersion(activeAppDir)
	target := pkgbuild.RuntimeVersion(filepath.Join(buildDir, baseMemberSlug))
	// An unknown lane on either side keeps the frozen pins, the safe default.
	if active == "" || target == "" || active == target {
		return nil
	}
	jobLogf(job, "runtime lane %s -> %s: using the target's framework version pins", active, target)
	members := make([]string, 0, len(m.Members))
	for _, ms := range m.Members {
		members = append(members, ms.Slug)
	}
	return pkgbuild.AdoptTargetPins(buildDir, members, pkgbuild.ScaffoldOptions{})
}
