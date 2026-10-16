package forms

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadHosts_ReadsTheFixture(t *testing.T) {
	defs, err := LoadHosts(filepath.Join("testdata", "form_hosts.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := defs.Host("gizmos:widget")
	if h == nil || h.Collection != "gizmos_widgets" {
		t.Fatalf("host = %+v", h)
	}
	if b := h.Builtin("tasks"); b == nil || b.Storage != "rows" || b.Mapper != "tasksMapper" {
		t.Fatalf("tasks builtin = %+v", b)
	}
	if b := h.Builtin("notes"); b == nil || b.Chrome != "bare" {
		t.Fatalf("notes builtin keeps its chrome: %+v", b)
	}
	if h.Builtin("ghost") != nil {
		t.Fatal("unknown builtin must be nil")
	}
	if o := defs.Host("gizmos:other"); o == nil || o.Collection != "gizmos_others" {
		t.Fatalf("other host = %+v", o)
	}
}

func TestLoadHosts_MissingFileIsEmpty(t *testing.T) {
	defs, err := LoadHosts(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil || len(defs.Hosts) != 0 {
		t.Fatalf("defs=%+v err=%v", defs, err)
	}
}

func TestLoadHosts_InvalidJSONIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "form_hosts.json")
	if err := os.WriteFile(path, []byte(`{"hosts":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadHosts(path); err == nil {
		t.Fatal("a hosts file that does not parse must be an error")
	}
}

func TestResolveHosts(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.json")
	broken := filepath.Join(dir, "broken.json")
	if err := os.WriteFile(broken, []byte(`not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	embedded := []byte(`{"hosts":[{"key":"gizmos:widget","collection":"gizmos_widgets"}]}`)
	if defs, err := resolveHosts(Options{HostsPath: missing}); err != nil || len(defs.Hosts) != 0 {
		t.Fatalf("a missing file is a lean shell: defs=%+v err=%v", defs, err)
	}
	if defs, err := resolveHosts(Options{HostsPath: missing, HostsJSON: embedded}); err != nil || len(defs.Hosts) != 1 {
		t.Fatalf("the embedded copy stands in for a missing file: defs=%+v err=%v", defs, err)
	}
	if _, err := resolveHosts(Options{HostsPath: broken, HostsJSON: embedded}); err == nil {
		t.Fatal("a file that does not parse must be an error, not a fallback")
	}
	if _, err := resolveHosts(Options{HostsPath: missing, HostsJSON: []byte(`{`)}); err == nil {
		t.Fatal("an embedded copy that does not parse must be an error")
	}
}

func TestParseHosts_DefaultsTheFileColumns(t *testing.T) {
	defs, err := ParseHosts([]byte(`{"hosts":[
		{"key":"gizmos:a","files":{"collection":"gizmos_files"}},
		{"key":"gizmos:b","files":{"collection":"gizmos_files","nameColumn":"title","fileColumn":"blob"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if f := defs.Host("gizmos:a").Files; f.NameColumn != "name" || f.FileColumn != "file" {
		t.Fatalf("defaults = %+v", f)
	}
	if f := defs.Host("gizmos:b").Files; f.NameColumn != "title" || f.FileColumn != "blob" {
		t.Fatalf("declared = %+v", f)
	}
}
