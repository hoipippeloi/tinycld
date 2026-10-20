package rlstest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// A template copy must be the database the replay builds, or every suite on
// it tests a schema no install has. Compare everything the migrations write:
// each collection (rules, fields, indexes), the applied-migrations ledger and
// the settings.
func TestFixtureMatchesReplay(t *testing.T) {
	cases := []struct {
		name   string
		replay func(t *testing.T) *tests.TestApp
		copy   func(t *testing.T) *tests.TestApp
	}{
		{
			name: "bundled data, core migrations",
			replay: func(t *testing.T) *tests.TestApp {
				app := NewApp(t)
				if err := ReconcileBundledUsers(app); err != nil {
					t.Fatal(err)
				}
				Apply(t, app, CoreMigrationsDir(t))
				return app
			},
			copy: func(t *testing.T) *tests.TestApp { return NewMigratedApp(t, CoreMigrationsDir(t)) },
		},
		{
			name: "empty data, core migrations",
			replay: func(t *testing.T) *tests.TestApp {
				app, err := tests.NewTestApp(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(app.Cleanup)
				Apply(t, app, CoreMigrationsDir(t))
				return app
			},
			copy: func(t *testing.T) *tests.TestApp { return NewAssembledApp(t) },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := dumpSchema(t, tc.replay(t))
			got := dumpSchema(t, tc.copy(t))
			if _, ok := want["collection pkg_registry"]; !ok {
				t.Fatal("the replay did not create core's collections; the comparison would prove nothing")
			}
			if len(got) != len(want) {
				t.Errorf("template has %d schema entries, replay has %d", len(got), len(want))
			}
			for k, w := range want {
				if g, ok := got[k]; !ok {
					t.Errorf("template lacks %s", k)
				} else if g != w {
					t.Errorf("%s differs\n  template: %s\n  replay:   %s", k, g, w)
				}
			}
			for k := range got {
				if _, ok := want[k]; !ok {
					t.Errorf("template has %s, which the replay does not", k)
				}
			}
		})
	}
}

func dumpSchema(t *testing.T, app core.App) map[string]string {
	t.Helper()
	out := map[string]string{}
	cols, err := app.FindAllCollections()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cols {
		out["collection "+c.Name] = withoutTimestamps(t, c)
	}

	var applied []string
	if err := app.DB().Select("file").From(core.DefaultMigrationsTable).Column(&applied); err != nil {
		t.Fatal(err)
	}
	slices.Sort(applied)
	out["migrations"] = strings.Join(applied, "\n")

	out["settings"] = withoutTimestamps(t, app.Settings())
	return out
}

// withoutTimestamps marshals v without its created/updated stamps, which
// record when a row was written rather than what the migrations made.
func withoutTimestamps(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "created")
	delete(m, "updated")
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// Every test gets its own copy: a row one test writes is not in the next
// test's database, whether the tests run one after the other or in parallel.
func TestFixtureCopiesAreIsolated(t *testing.T) {
	fixture := Fixture{Base: BundledData, Prepare: ReconcileBundledUsers, MigrationsDirs: []string{CoreMigrationsDir(t)}}

	t.Run("sequential", func(t *testing.T) {
		t.Run("first writes", func(t *testing.T) {
			app := fixture.NewApp(t)
			saveUser(t, app, "first@test.local")
			requireUsers(t, app, []string{"first@test.local"}, []string{"second@test.local"})
		})
		t.Run("second does not see it", func(t *testing.T) {
			app := fixture.NewApp(t)
			saveUser(t, app, "second@test.local")
			requireUsers(t, app, []string{"second@test.local"}, []string{"first@test.local"})
		})
	})

	t.Run("parallel", func(t *testing.T) {
		emails := []string{"a@test.local", "b@test.local", "c@test.local"}
		for _, email := range emails {
			others := slices.DeleteFunc(slices.Clone(emails), func(e string) bool { return e == email })
			t.Run(email, func(t *testing.T) {
				t.Parallel()
				app := fixture.NewApp(t)
				saveUser(t, app, email)
				requireUsers(t, app, []string{email}, others)
			})
		}
	})
}

func saveUser(t *testing.T, app core.App, email string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	r := core.NewRecord(col)
	r.SetEmail(email)
	r.Set("username", strings.Split(email, "@")[0])
	r.Set("name", "Test")
	r.Set("role", "member")
	r.SetPassword("Password123!")
	if err := app.Save(r); err != nil {
		t.Fatal(err)
	}
}

func requireUsers(t *testing.T, app core.App, present, absent []string) {
	t.Helper()
	for _, email := range present {
		if _, err := app.FindAuthRecordByEmail("users", email); err != nil {
			t.Errorf("%s missing from this test's own copy: %v", email, err)
		}
	}
	for _, email := range absent {
		if _, err := app.FindAuthRecordByEmail("users", email); err == nil {
			t.Errorf("%s, written by another test, is in this test's copy", email)
		}
	}
}

// The key covers each migration's content, so a binary never serves a
// template built from a file that has since changed.
func TestFixtureKeyFollowsMigrationContent(t *testing.T) {
	dir := t.TempDir()
	if err := stageMerged(dir, []string{CoreMigrationsDir(t)}); err != nil {
		t.Fatal(err)
	}
	fixture := Fixture{Base: EmptyData, MigrationsDirs: []string{dir}}
	before := mustKey(t, fixture)

	if again := mustKey(t, fixture); again != before {
		t.Fatal("the key of unchanged migrations is not stable")
	}

	elsewhere := t.TempDir()
	if err := stageMerged(elsewhere, []string{dir}); err != nil {
		t.Fatal(err)
	}
	if got := mustKey(t, Fixture{Base: EmptyData, MigrationsDirs: []string{elsewhere}}); got != before {
		t.Error("the same migrations in another directory got another key; the key must follow content, not path")
	}

	names, err := migrationFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	edited := filepath.Join(dir, names[len(names)-1])
	body, err := os.ReadFile(edited)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(edited, append(body, []byte("\n// edited\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if mustKey(t, fixture) == before {
		t.Errorf("editing %s did not change the template key", filepath.Base(edited))
	}

	if mustKey(t, Fixture{Base: BundledData, MigrationsDirs: []string{elsewhere}}) == before {
		t.Error("another base got the same key")
	}
	if mustKey(t, Fixture{Base: EmptyData, Prepare: ReconcileBundledUsers, MigrationsDirs: []string{elsewhere}}) == before {
		t.Error("adding a Prepare step did not change the key")
	}
}

// A closure's captured values are invisible to the key, so two tests could
// share a template their Prepare steps would have built differently.
func TestFixtureRefusesClosurePrepare(t *testing.T) {
	collection := "anything"
	fixture := Fixture{
		Prepare:        func(app core.App) error { return app.Save(core.NewBaseCollection(collection)) },
		MigrationsDirs: []string{CoreMigrationsDir(t)},
	}
	if _, err := fixture.key(); err == nil || !strings.Contains(err.Error(), "named function") {
		t.Fatalf("a closure Prepare was accepted (err = %v)", err)
	}
}

func mustKey(t *testing.T, f Fixture) string {
	t.Helper()
	key, err := f.key()
	if err != nil {
		t.Fatal(err)
	}
	return key
}
