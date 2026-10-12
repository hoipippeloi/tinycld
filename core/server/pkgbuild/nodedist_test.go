package pkgbuild

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Masterminds/semver/v3"
)

type tarEntry struct {
	name, body, link string
	dir              bool
}

func nodeTarball(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o755}
		switch {
		case e.dir:
			hdr.Typeflag = tar.TypeDir
		case e.link != "":
			hdr.Typeflag, hdr.Linkname = tar.TypeSymlink, e.link
		default:
			hdr.Typeflag, hdr.Size = tar.TypeReg, int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// nodeDistServer serves an index with the given releases and one tarball for
// v22.12.0 on linux-x64. sum overrides the listed checksum when non-empty.
func nodeDistServer(t *testing.T, tarball []byte, sum string, hits *int) *httptest.Server {
	t.Helper()
	if sum == "" {
		h := sha256.Sum256(tarball)
		sum = hex.EncodeToString(h[:])
	}
	index := `[
		{"version":"v24.1.0","files":["linux-x64"],"lts":false},
		{"version":"v22.12.0","files":["linux-x64","osx-arm64-tar"],"lts":"Jod"},
		{"version":"v22.11.0","files":["linux-x64"],"lts":"Jod"},
		{"version":"v20.18.0","files":["linux-x64"],"lts":"Iron"}
	]`
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			fmt.Fprint(w, index)
		case "/v22.12.0/SHASUMS256.txt":
			fmt.Fprintf(w, "%s  node-v22.12.0-linux-x64.tar.gz\n", sum)
		case "/v22.12.0/node-v22.12.0-linux-x64.tar.gz":
			if hits != nil {
				*hits++
			}
			_, _ = w.Write(tarball)
		default:
			http.NotFound(w, r)
		}
	}))
}

var goodNodeTar = []tarEntry{
	{name: "node-v22.12.0-linux-x64/", dir: true},
	{name: "node-v22.12.0-linux-x64/bin/node", body: "#!/bin/sh\necho v22.12.0\n"},
	{name: "node-v22.12.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js", body: "//npm"},
	{name: "node-v22.12.0-linux-x64/bin/npm", link: "../lib/node_modules/npm/bin/npm-cli.js"},
}

func TestNodeDistEnsure_DownloadsChecksAndReuses(t *testing.T) {
	var hits int
	srv := nodeDistServer(t, nodeTarball(t, goodNodeTar), "", &hits)
	defer srv.Close()
	d := NodeDist{Dir: t.TempDir(), BaseURL: srv.URL, GOOS: "linux", GOARCH: "amd64"}

	dir, err := d.Ensure(">=22 <23")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(d.Dir, "v22.12.0"); dir != want {
		t.Fatalf("dir = %s, want %s", dir, want)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "bin", "node")); err != nil || !strings.Contains(string(body), "v22.12.0") {
		t.Fatalf("bin/node not extracted: %v %q", err, body)
	}
	if link, err := os.Readlink(filepath.Join(dir, "bin", "npm")); err != nil || link != "../lib/node_modules/npm/bin/npm-cli.js" {
		t.Fatalf("bin/npm symlink = %q, %v", link, err)
	}
	if _, err := d.Ensure(">=22 <23"); err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("tarball downloaded %d times, want 1 (second Ensure must reuse)", hits)
	}
}

func TestNodeDistEnsure_RefusesChecksumMismatch(t *testing.T) {
	srv := nodeDistServer(t, nodeTarball(t, goodNodeTar), strings.Repeat("0", 64), nil)
	defer srv.Close()
	d := NodeDist{Dir: t.TempDir(), BaseURL: srv.URL, GOOS: "linux", GOARCH: "amd64"}

	_, err := d.Ensure(">=22 <23")
	if err == nil || !strings.Contains(err.Error(), "does not match SHASUMS256.txt") {
		t.Fatalf("expected a checksum refusal, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(d.Dir, "v22.12.0")); !os.IsNotExist(statErr) {
		t.Fatal("a refused download must not leave a version directory")
	}
}

func TestNodeDistEnsure_RefusesEntriesOutsideArchive(t *testing.T) {
	for name, entries := range map[string][]tarEntry{
		"path":    {{name: "node-v22.12.0-linux-x64/../../evil", body: "x"}},
		"symlink": {{name: "node-v22.12.0-linux-x64/bin/node", link: "../../../../etc/passwd"}},
	} {
		t.Run(name, func(t *testing.T) {
			srv := nodeDistServer(t, nodeTarball(t, entries), "", nil)
			defer srv.Close()
			d := NodeDist{Dir: t.TempDir(), BaseURL: srv.URL, GOOS: "linux", GOARCH: "amd64"}
			if _, err := d.Ensure(">=22 <23"); err == nil || !strings.Contains(err.Error(), "outside the archive") {
				t.Fatalf("expected an outside-the-archive refusal, got %v", err)
			}
		})
	}
}

func TestPickNodeRelease_PrefersNewestLTSInRange(t *testing.T) {
	releases := []nodeRelease{
		{Version: "v24.1.0", Files: []string{"linux-x64"}, LTS: false},
		{Version: "v22.12.0", Files: []string{"linux-x64", "osx-arm64-tar"}, LTS: "Jod"},
		{Version: "v22.13.0-rc.1", Files: []string{"linux-x64"}, LTS: "Jod"},
		{Version: "v20.18.0", Files: []string{"linux-x64"}, LTS: "Iron"},
	}
	for _, tc := range []struct{ rng, platform, want string }{
		{">=22", "linux-x64", "v22.12.0"},    // LTS beats a newer Current
		{">=23", "linux-x64", "v24.1.0"},     // no LTS in range: newest
		{">=22", "darwin-arm64", "v22.12.0"}, // macOS reads the osx-*-tar file
		{">=20 <21", "darwin-arm64", ""},     // no macOS tarball listed
		{">=26", "linux-x64", ""},
	} {
		c, err := semver.NewConstraint(tc.rng)
		if err != nil {
			t.Fatal(err)
		}
		if got := pickNodeRelease(releases, c, tc.platform); got != tc.want {
			t.Errorf("pick(%s, %s) = %q, want %q", tc.rng, tc.platform, got, tc.want)
		}
	}
}

func TestNodeSatisfies(t *testing.T) {
	for _, tc := range []struct {
		version, rng string
		want         bool
	}{
		{"v22.12.0\n", ">=22", true},
		{"v20.18.0", ">=22", false},
		{"v20.19.4", "^20.19.0 || >=22.12.0", true},
	} {
		got, err := NodeSatisfies(tc.version, tc.rng)
		if err != nil || got != tc.want {
			t.Errorf("NodeSatisfies(%q, %q) = %v, %v; want %v", tc.version, tc.rng, got, err, tc.want)
		}
	}
}
