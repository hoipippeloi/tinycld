package forms

import (
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
