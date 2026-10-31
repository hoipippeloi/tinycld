package coreserver

import (
	"strings"
	"testing"
)

// Discovery runs in its own goroutine per row; a panic there must become that
// row's error, not end the process.
func TestVersionInfosForRows_PanicBecomesARowError(t *testing.T) {
	rows := registryRows(t, 3)
	discover := func(spec string) (pkgSource, []string, string) {
		if strings.HasSuffix(spec, "pkg01") {
			panic("registry answer exploded")
		}
		return sourceNpm, []string{"2.0.0"}, ""
	}

	infos := versionInfosForRows(rows, discover)

	if infos[1].Slug != "pkg01" || infos[1].Error == "" {
		t.Fatalf("infos[1] = %+v, want pkg01 with an error", infos[1])
	}
	if infos[0].Latest != "2.0.0" || infos[2].Latest != "2.0.0" {
		t.Fatalf("the other rows must still resolve, got %+v", infos)
	}
}
