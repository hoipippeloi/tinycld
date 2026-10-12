package coreserver

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tinycld.org/core/installjob"
	"tinycld.org/core/pkgbuild"
)

// A rebuild compiles the TARGET release with this install's tools, and a
// target may pin newer ones than the image was built with: v0.7.0 moved pnpm
// 11 → 12 and Go 1.27.1 → 1.27.2. The install fetches what the target needs
// into stateToolchainsDir before the build:
//   - pnpm: corepack fetches the target's pin on first use, but the image's
//     COREPACK_HOME is read-only to the runtime user, so it moves to a
//     writable copy.
//   - Go: GOTOOLCHAIN=auto (Go's default) fetches the toolchain a go.mod asks
//     for into the module cache; nothing to set up.
//   - Node: nothing fetches it, so a target whose engines.node the running
//     Node does not satisfy gets an official release, checked against its
//     SHASUMS256.txt, put first on PATH.
// pkgbuild.VerifyBuildTools then has the final word.

func stateToolchainsDir() string { return filepath.Join(resolveStateDir(), "toolchains") }

// nodeCurrentDir is the symlink to the Node release builds use; its bin/ is
// first on PATH once a release has been fetched.
func nodeCurrentDir() string { return filepath.Join(stateToolchainsDir(), "node", "current") }

// prepareBuildTools fetches the tools the assembled target needs and verifies
// them. A failure leaves live state untouched; the caller discards the build.
func prepareBuildTools(job *installjob.Job, buildDir string) error {
	if err := useToolchainEnv(job); err != nil {
		return err
	}
	if err := ensureNode(job, buildDir); err != nil {
		jobLogf(job, "could not fetch Node.js: %v", err)
	}
	return pkgbuild.VerifyBuildTools(buildDir, nil)
}

// useToolchainEnv points this process (and so every build child) at the
// writable tool locations. Idempotent.
func useToolchainEnv(job *installjob.Job) error {
	if home := os.Getenv("COREPACK_HOME"); home != "" && !dirWritable(home) {
		writable := filepath.Join(stateToolchainsDir(), "corepack")
		if _, err := os.Stat(writable); os.IsNotExist(err) {
			// Seed from the image's copy so the pnpm it already holds is not
			// fetched again. Copy aside and rename, so an interrupted copy is
			// never mistaken for a complete one.
			partial := writable + ".partial"
			_ = os.RemoveAll(partial)
			if err := pkgbuild.CopyDir(home, partial); err != nil {
				return fmt.Errorf("copy corepack home %s: %w", home, err)
			}
			if err := os.Rename(partial, writable); err != nil {
				return err
			}
		}
		if err := os.Setenv("COREPACK_HOME", writable); err != nil {
			return err
		}
		jobLogf(job, "corepack home %s is read-only; using %s", home, writable)
	}
	if _, err := os.Stat(filepath.Join(nodeCurrentDir(), "bin", "node")); err == nil {
		prependPath(filepath.Join(nodeCurrentDir(), "bin"))
	}
	return nil
}

// ensureNode fetches a Node release when the running one does not satisfy the
// target's engines.node range.
func ensureNode(job *installjob.Job, buildDir string) error {
	want := pkgbuild.RequiredNode(buildDir)
	if want == "" {
		return nil
	}
	out, err := pkgbuild.RunCmd(".", "node", "--version")
	if err == nil {
		if ok, cerr := pkgbuild.NodeSatisfies(out, want); cerr == nil && ok {
			return nil
		}
	}
	jobLogf(job, "target needs node %s (running: %s); fetching it", want, strings.TrimSpace(out))
	dir, err := pkgbuild.NodeDist{Dir: filepath.Join(stateToolchainsDir(), "node")}.Ensure(want)
	if err != nil {
		return err
	}
	// Swap the symlink atomically, so a concurrent PATH lookup never finds it
	// missing.
	tmp := nodeCurrentDir() + ".new"
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Base(dir), tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, nodeCurrentDir()); err != nil {
		return err
	}
	prependPath(filepath.Join(nodeCurrentDir(), "bin"))
	jobLogf(job, "node %s ready at %s", filepath.Base(dir), dir)
	return nil
}

// prependPath puts dir first on this process's PATH unless it already is on it.
func prependPath(dir string) {
	path := os.Getenv("PATH")
	for _, p := range filepath.SplitList(path) {
		if p == dir {
			return
		}
	}
	_ = os.Setenv("PATH", dir+string(os.PathListSeparator)+path)
}

func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".write-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}
