package coreserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFormHostsPath_PrefersTheNestedServerDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "server"), 0o755); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(dir, "server", formHostsFile)
	if err := os.WriteFile(nested, []byte(`{"hosts":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := formHostsPath(dir); got != nested {
		t.Fatalf("got %s", got)
	}
}

func TestFormHostsPath_FallsBackToTheFlatDir(t *testing.T) {
	dir := t.TempDir()
	if got := formHostsPath(dir); got != filepath.Join(dir, formHostsFile) {
		t.Fatalf("got %s", got)
	}
}
