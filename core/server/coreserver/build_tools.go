package coreserver

import (
	"fmt"
	"io"
	"io/fs"
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
//     COREPACK_HOME is read-only to the runtime user, so the server moves it
//     to a writable copy at start-up.
//   - Go: GOTOOLCHAIN=auto (Go's default) fetches the toolchain a go.mod asks
//     for into the module cache; nothing to set up.
//   - Node: nothing fetches it, so a target whose engines.node the image's
//     Node does not satisfy gets an official release, checked against its
//     SHASUMS256.txt, put first on PATH for that build.
// pkgbuild.VerifyBuildTools then has the final word.

func stateToolchainsDir() string { return filepath.Join(resolveStateDir(), "toolchains") }

// nodeCurrentDir is the symlink to the last Node release fetched; its bin/
// goes first on PATH only for a build the image's Node cannot serve.
func nodeCurrentDir() string { return filepath.Join(stateToolchainsDir(), "node", "current") }

// prepareBuildTools fetches the tools the assembled target needs and verifies
// them. A failure leaves live state untouched; the caller discards the build.
func prepareBuildTools(job *installjob.Job, buildDir string) error {
	logf := func(format string, args ...any) { jobLogf(job, format, args...) }
	if err := useWritableCorepackHome(logf); err != nil {
		return err
	}
	if err := ensureNode(logf, buildDir); err != nil {
		logf("could not fetch Node.js: %v", err)
	}
	return pkgbuild.VerifyBuildTools(buildDir, nil)
}

// useWritableCorepackHome points this process (and so every pnpm it runs) at a
// writable corepack home when COREPACK_HOME is read-only, as the image's
// /opt/corepack is to the runtime user. Register calls it at start-up, because
// the env does not survive the restart that ends an update and pnpm also runs
// outside a rebuild; prepareBuildTools calls it again for safety. Each call
// seeds the writable copy from the read-only one: entries it does not hold yet
// are copied (so a newer image's pnpm needs no download), existing entries are
// kept (they may be newer downloads), and lastKnownGood.json follows the image.
func useWritableCorepackHome(logf func(format string, args ...any)) error {
	home := os.Getenv("COREPACK_HOME")
	if home == "" || dirWritable(home) {
		return nil
	}
	writable := filepath.Join(stateToolchainsDir(), "corepack")
	if err := seedCorepackHome(home, writable); err != nil {
		return fmt.Errorf("seed corepack home %s from %s: %w", writable, home, err)
	}
	if err := os.Setenv("COREPACK_HOME", writable); err != nil {
		return err
	}
	logf("corepack home %s is read-only; using %s", home, writable)
	return nil
}

// seedCorepackHome copies into dst every entry of src that dst lacks, and
// always src's lastKnownGood.json. Each file is written beside its target and
// renamed into place, so an interrupted seed never leaves a partial file that
// a later seed would keep.
func seedCorepackHome(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if _, err := os.Lstat(target); err == nil && rel != "lastKnownGood.json" {
			return nil
		}
		tmp := target + ".seed"
		_ = os.Remove(tmp)
		if d.Type()&fs.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, tmp); err != nil {
				return err
			}
		} else if err := copyFileMode(path, tmp); err != nil {
			return err
		}
		return os.Rename(tmp, target)
	})
}

func copyFileMode(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ensureNode decides which Node the build runs on: the image's when it
// satisfies the target's engines.node, else an earlier download that does,
// else a new download. Only the last two put the download first on PATH, so
// a newer image's Node is never hidden behind an old download in the state
// volume.
func ensureNode(logf func(format string, args ...any), buildDir string) error {
	cachedBin := filepath.Join(nodeCurrentDir(), "bin")
	removeFromPath(cachedBin)
	want := pkgbuild.RequiredNode(buildDir)
	if want == "" || nodeOK("node", want) {
		return nil
	}
	if nodeOK(filepath.Join(cachedBin, "node"), want) {
		prependPath(cachedBin)
		logf("target needs node %s; using the earlier download at %s", want, cachedBin)
		return nil
	}
	logf("target needs node %s, which this server does not have; fetching it", want)
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
	prependPath(cachedBin)
	logf("node %s ready at %s", filepath.Base(dir), dir)
	return nil
}

// nodeOK reports whether the node binary at bin runs and satisfies want.
func nodeOK(bin, want string) bool {
	out, err := pkgbuild.RunCmd(".", bin, "--version")
	if err != nil {
		return false
	}
	ok, err := pkgbuild.NodeSatisfies(out, want)
	return err == nil && ok
}

// removeFromPath drops dir from this process's PATH.
func removeFromPath(dir string) {
	var keep []string
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p != dir {
			keep = append(keep, p)
		}
	}
	_ = os.Setenv("PATH", strings.Join(keep, string(os.PathListSeparator)))
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
