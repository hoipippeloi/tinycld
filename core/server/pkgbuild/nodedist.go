package pkgbuild

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
)

// NodeDistURL is the official Node.js release index. The download checks each
// tarball against that release's SHASUMS256.txt.
const NodeDistURL = "https://nodejs.org/dist"

// NodeDist downloads official Node.js releases into Dir, one directory per
// version (Dir/v22.12.0). The zero value of BaseURL and Client means
// NodeDistURL and a client with a 10-minute timeout.
type NodeDist struct {
	Dir     string
	BaseURL string
	Client  *http.Client
	GOOS    string // default runtime.GOOS
	GOARCH  string // default runtime.GOARCH
}

// RequiredNode is the engines.node range the target base member declares, or
// "" when it declares none.
func RequiredNode(buildDir string) string {
	data, err := os.ReadFile(filepath.Join(buildDir, BaseMemberSlug, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	return pkg.Engines.Node
}

// NodeSatisfies reports whether a `node --version` string ("v22.12.0")
// satisfies the engines range.
func NodeSatisfies(version, rangeSpec string) (bool, error) {
	c, err := semver.NewConstraint(rangeSpec)
	if err != nil {
		return false, fmt.Errorf("invalid engines.node range %q: %w", rangeSpec, err)
	}
	v, err := semver.NewVersion(strings.TrimSpace(version))
	if err != nil {
		return false, fmt.Errorf("unrecognized node version %q: %w", version, err)
	}
	return c.Check(v), nil
}

type nodeRelease struct {
	Version string   `json:"version"`
	Files   []string `json:"files"`
	LTS     any      `json:"lts"` // false, or the LTS codename
}

// Ensure makes a Node release that satisfies rangeSpec present under d.Dir and
// returns its directory (whose bin/ holds node). See pickNodeRelease for which
// release; a directory an earlier call already filled is reused.
func (d NodeDist) Ensure(rangeSpec string) (string, error) {
	return d.EnsureContext(context.Background(), rangeSpec)
}

// EnsureContext is Ensure with every download bound to ctx.
func (d NodeDist) EnsureContext(ctx context.Context, rangeSpec string) (string, error) {
	c, err := semver.NewConstraint(rangeSpec)
	if err != nil {
		return "", fmt.Errorf("invalid engines.node range %q: %w", rangeSpec, err)
	}
	platform, err := d.platform()
	if err != nil {
		return "", err
	}
	var releases []nodeRelease
	if err := d.getJSON(ctx, d.baseURL()+"/index.json", &releases); err != nil {
		return "", err
	}
	version := pickNodeRelease(releases, c, platform)
	if version == "" {
		return "", fmt.Errorf("no Node.js release for %s satisfies %q", platform, rangeSpec)
	}
	dest := filepath.Join(d.Dir, version)
	if _, err := os.Stat(filepath.Join(dest, "bin", "node")); err == nil {
		return dest, nil
	}
	if err := d.install(ctx, version, platform, dest); err != nil {
		return "", fmt.Errorf("install Node.js %s: %w", version, err)
	}
	return dest, nil
}

// pickNodeRelease picks the release a build runs on: from the LTS releases in
// range that ship a tarball for platform (or, when none is LTS, from all of
// them), the newest release of the LOWEST major. A download happens only when
// the image's Node is below engines.node, and the release that raised that
// floor ships an image on the floor's major; an open range such as ">=22" must
// not move a lagging install onto a newer major that no image or CI run used.
// The LTS preference keeps a range whose floor is an odd major (never LTS, and
// soon out of support) on the next LTS major. Returns "" when nothing fits.
func pickNodeRelease(releases []nodeRelease, c *semver.Constraints, platform string) string {
	var lts, all []*semver.Version
	raw := map[*semver.Version]string{}
	for _, r := range releases {
		if !hasNodeFile(r.Files, platform) {
			continue
		}
		v, err := semver.NewVersion(r.Version)
		if err != nil || v.Prerelease() != "" || !c.Check(v) {
			continue
		}
		raw[v] = r.Version
		all = append(all, v)
		if name, ok := r.LTS.(string); ok && name != "" {
			lts = append(lts, v)
		}
	}
	pool := lts
	if len(pool) == 0 {
		pool = all
	}
	var best *semver.Version
	for _, v := range pool {
		if best == nil || v.Major() < best.Major() || (v.Major() == best.Major() && v.GreaterThan(best)) {
			best = v
		}
	}
	if best == nil {
		return ""
	}
	return raw[best]
}

// hasNodeFile reports whether a release ships a .tar.gz for platform. The
// index names a macOS tarball "osx-<arch>-tar" and a Linux one "linux-<arch>".
func hasNodeFile(files []string, platform string) bool {
	want := platform
	if goos, arch, ok := strings.Cut(platform, "-"); ok && goos == "darwin" {
		want = "osx-" + arch + "-tar"
	}
	for _, f := range files {
		if f == want {
			return true
		}
	}
	return false
}

// platform is the tarball's "<os>-<arch>" part: linux-x64, darwin-arm64, …
func (d NodeDist) platform() (string, error) {
	goos, goarch := d.GOOS, d.GOARCH
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	if goos != "linux" && goos != "darwin" {
		return "", fmt.Errorf("no Node.js download for %s", goos)
	}
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	if arch == "" {
		return "", fmt.Errorf("no Node.js download for %s/%s", goos, goarch)
	}
	return goos + "-" + arch, nil
}

func (d NodeDist) install(ctx context.Context, version, platform, dest string) error {
	name := fmt.Sprintf("node-%s-%s.tar.gz", version, platform)
	sum, err := d.expectedSHA256(ctx, version, name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d.Dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(d.Dir, name+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	resp, err := d.get(ctx, d.baseURL()+"/"+version+"/"+name)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", name, resp.StatusCode)
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		return fmt.Errorf("download %s: %w", name, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sum {
		return fmt.Errorf("%s: SHA-256 %s does not match SHASUMS256.txt (%s)", name, got, sum)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}

	// Extract beside dest and rename into place, so a failed or interrupted
	// extract never leaves a half-filled version directory that Ensure reuses.
	staging, err := os.MkdirTemp(d.Dir, version+".partial-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := extractTarGzStrip1(tmp, staging); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(staging, "bin", "node")); err != nil {
		return fmt.Errorf("%s has no bin/node", name)
	}
	_ = os.RemoveAll(dest)
	return os.Rename(staging, dest)
}

func (d NodeDist) expectedSHA256(ctx context.Context, version, name string) (string, error) {
	resp, err := d.get(ctx, d.baseURL()+"/"+version+"/SHASUMS256.txt")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("SHASUMS256.txt for %s: HTTP %d", version, resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && fields[1] == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("SHASUMS256.txt for %s does not list %s", version, name)
}

// extractTarGzStrip1 unpacks a Node tarball into dest, dropping its top-level
// "node-vX-os-arch/" directory. It refuses entries and symlinks that would
// land outside dest.
func extractTarGzStrip1(r io.Reader, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		_, rel, ok := strings.Cut(strings.TrimPrefix(hdr.Name, "./"), "/")
		if !ok || rel == "" {
			continue
		}
		target, err := insideDir(dest, rel)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)&0o755|0o644)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(hdr.Linkname) {
				return fmt.Errorf("tar entry %s links outside the archive", hdr.Name)
			}
			if _, err := insideDir(dest, filepath.Join(filepath.Dir(rel), hdr.Linkname)); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		}
	}
}

// insideDir joins rel onto dir and refuses a result outside dir.
func insideDir(dir, rel string) (string, error) {
	target := filepath.Join(dir, rel)
	if target != dir && !strings.HasPrefix(target, dir+string(filepath.Separator)) {
		return "", fmt.Errorf("tar entry %s is outside the archive", rel)
	}
	return target, nil
}

// get is a GET of url bound to ctx.
func (d NodeDist) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return d.client().Do(req)
}

func (d NodeDist) getJSON(ctx context.Context, url string, v any) error {
	resp, err := d.get(ctx, url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func (d NodeDist) baseURL() string {
	if d.BaseURL != "" {
		return strings.TrimRight(d.BaseURL, "/")
	}
	return NodeDistURL
}

func (d NodeDist) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return &http.Client{Timeout: 10 * time.Minute}
}
