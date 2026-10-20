package rlstest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Replaying every migration costs about 4–10 s per app under -race, and most
// suites build a fresh app per test, so a package of a few hundred such tests
// ran past go test's 10-minute limit. A Fixture applies its migrations once per
// test binary and gives each test a private copy of the result.
//
// The copy is the whole data dir, taken after the migrations and before
// anything else touches the app. Hooks, Register calls and seed rows are not in
// it: a test binds those to its own app after NewApp returns, exactly as it did
// when it replayed the migrations itself.
//
// The template is held in memory and never written to a shared place on disk,
// so nothing outlives the test binary and no run can see another run's
// template.

// Base is the data dir a Fixture starts from, before its migrations.
type Base int

const (
	// BundledData is PocketBase's own test data dir, what tests.NewTestApp()
	// with no argument opens: demo collections, sample users and all.
	BundledData Base = iota
	// EmptyData is a data dir with only PocketBase's system migrations, what a
	// real install starts from.
	EmptyData
)

func (b Base) String() string {
	switch b {
	case BundledData:
		return "bundled"
	case EmptyData:
		return "empty"
	}
	return fmt.Sprintf("Base(%d)", int(b))
}

// Fixture describes a migrated database: where it starts, what runs on it
// before the migrations, and which migrations run. Every test in one binary
// that asks for an equal Fixture gets a copy of the same template.
type Fixture struct {
	Base Base

	// Prepare runs on the base before any migration: a bare collection the
	// migrations reference, or a fix-up of the bundled data. Its result is
	// shared by every test that names the same Fixture, so it must be a named
	// function (not a closure) that reads nothing but the app: its name keys
	// the template, and a closure's captured values would not.
	Prepare func(app core.App) error

	// MigrationsDirs run as Apply runs them: each directory in turn, its .js
	// files in filename order.
	MigrationsDirs []string
}

// NewApp returns a TestApp on a private copy of the fixture's template. The
// app is cleaned up when the test ends.
func (f Fixture) NewApp(t testing.TB) *tests.TestApp {
	t.Helper()
	dir := f.DataDir(t)

	globalMigrations.RLock()
	app, err := tests.NewTestApp(dir)
	globalMigrations.RUnlock()
	if err != nil {
		t.Fatalf("rlstest: NewTestApp from template: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })
	return app
}

// DataDir returns a private copy of the fixture's template data dir, removed
// when the test ends. Use it for an app that is not a TestApp — a real
// *pocketbase.PocketBase takes it as DefaultDataDir.
func (f Fixture) DataDir(t testing.TB) string {
	t.Helper()
	tpl, err := f.template()
	if err != nil {
		t.Fatalf("rlstest: %v", err)
	}
	dir := t.TempDir()
	if err := tpl.writeTo(dir); err != nil {
		t.Fatalf("rlstest: copy template: %v", err)
	}
	return dir
}

// NewMigratedApp returns an app on PocketBase's bundled test data with the
// bundled users reconciled (ReconcileBundledUsers) and dirs applied as Apply
// applies them. It replaces the NewApp + username-index fix-up + Apply recipe
// that most rule suites repeat.
func NewMigratedApp(t testing.TB, dirs ...string) *tests.TestApp {
	t.Helper()
	if len(dirs) == 0 {
		t.Fatal("rlstest: NewMigratedApp needs at least one migrations directory")
	}
	return Fixture{Base: BundledData, Prepare: ReconcileBundledUsers, MigrationsDirs: dirs}.NewApp(t)
}

// ReconcileBundledUsers makes the bundled test data's users collection look
// like a real pre-1820000000 database. The bundled collection already carries
// the username unique index that 1820000000 adds, and the duplicate is
// rejected; it also lists username as an identity field, which demands that
// index. Drop both so the migration applies as it does against a real DB.
func ReconcileBundledUsers(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}
	var kept types.JSONArray[string]
	for _, idx := range users.Indexes {
		if !strings.Contains(idx, "username") {
			kept = append(kept, idx)
		}
	}
	users.Indexes = kept
	users.PasswordAuth.IdentityFields = []string{"email"}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("drop bundled username index: %w", err)
	}
	return nil
}

// globalMigrations serialises access to core.AppMigrations, the package-level
// list jsvm appends to: a template build replaces it while it runs, and
// tests.NewTestApp reads it.
var globalMigrations sync.RWMutex

type template struct {
	once  sync.Once
	files map[string][]byte
	err   error
}

var (
	templatesMu sync.Mutex
	templates   = map[string]*template{}
)

func (f Fixture) template() (*template, error) {
	key, err := f.key()
	if err != nil {
		return nil, err
	}
	templatesMu.Lock()
	tpl, ok := templates[key]
	if !ok {
		tpl = &template{}
		templates[key] = tpl
	}
	templatesMu.Unlock()

	tpl.once.Do(func() {
		tpl.files, tpl.err = f.build()
	})
	if tpl.err != nil {
		return nil, fmt.Errorf("build template: %w", tpl.err)
	}
	return tpl, nil
}

var closureName = regexp.MustCompile(`\.func\d+(\.\d+)*$|-fm$`)

// key identifies a template by everything that shapes it: the base, the
// Prepare function, and every migration file's name and content, per
// directory and in order. An edited migration yields a new key, so a binary
// never serves a template built from other content.
func (f Fixture) key() (string, error) {
	if len(f.MigrationsDirs) == 0 {
		return "", errors.New("a Fixture needs at least one migrations directory")
	}
	h := sha256.New()
	fmt.Fprintf(h, "base=%s\n", f.Base)
	if f.Prepare != nil {
		name := runtime.FuncForPC(reflect.ValueOf(f.Prepare).Pointer()).Name()
		if closureName.MatchString(name) {
			return "", fmt.Errorf("Fixture.Prepare must be a named function, not %s: its name keys the shared template", name)
		}
		fmt.Fprintf(h, "prepare=%s\n", name)
	}
	for _, dir := range f.MigrationsDirs {
		files, err := migrationFiles(dir)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "dir %d\n", len(files))
		for _, name := range files {
			body, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				return "", err
			}
			fmt.Fprintf(h, "%s %d\n", name, len(body))
			h.Write(body)
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// migrationFiles lists the files jsvm loads from dir as migrations, sorted.
func migrationFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	hasJS := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		switch filepath.Ext(e.Name()) {
		case ".js":
			hasJS = true
			names = append(names, e.Name())
		case ".ts":
			names = append(names, e.Name())
		}
	}
	if !hasJS {
		return nil, fmt.Errorf("no .js migrations in %s — wrong path?", dir)
	}
	slices.Sort(names)
	return names, nil
}

func (f Fixture) build() (map[string][]byte, error) {
	globalMigrations.Lock()
	defer globalMigrations.Unlock()

	saved := core.AppMigrations
	defer func() { core.AppMigrations = saved }()
	// The base must see PocketBase's system migrations only; a list a test's
	// Apply left behind would otherwise run on it too.
	core.AppMigrations = core.MigrationsList{}

	var app *tests.TestApp
	var err error
	switch f.Base {
	case BundledData:
		app, err = tests.NewTestApp()
	case EmptyData:
		empty, mkErr := os.MkdirTemp("", "rlstest_empty_*")
		if mkErr != nil {
			return nil, mkErr
		}
		defer os.RemoveAll(empty)
		app, err = tests.NewTestApp(empty)
	default:
		return nil, fmt.Errorf("unknown base %s", f.Base)
	}
	if err != nil {
		return nil, fmt.Errorf("NewTestApp: %w", err)
	}
	dataDir := app.DataDir()
	defer os.RemoveAll(dataDir)

	hooksDir, err := os.MkdirTemp("", "rlstest_hooks_*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(hooksDir)

	if f.Prepare != nil {
		if err := f.Prepare(app); err != nil {
			_ = app.ResetBootstrapState()
			return nil, fmt.Errorf("prepare: %w", err)
		}
	}
	if err := applyDirs(app, hooksDir, f.MigrationsDirs); err != nil {
		_ = app.ResetBootstrapState()
		return nil, err
	}

	// Closing the connections checkpoints the WAL into data.db, so the files
	// read below are the whole database.
	if err := app.ResetBootstrapState(); err != nil {
		return nil, fmt.Errorf("close template app: %w", err)
	}
	return snapshotDir(dataDir)
}

func snapshotDir(root string) (map[string][]byte, error) {
	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[rel] = body
		return nil
	})
	return files, err
}

func (tpl *template) writeTo(dir string) error {
	for rel, body := range tpl.files {
		dst := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, body, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// stageMerged copies the .js migrations of dirs into one directory, as a real
// install merges every package's migrations, refusing two files of one name.
func stageMerged(dst string, dirs []string) error {
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if filepath.Ext(e.Name()) != ".js" {
				continue
			}
			target := filepath.Join(dst, e.Name())
			if _, err := os.Stat(target); err == nil {
				return fmt.Errorf("two migrations named %s — a real install would load only one", e.Name())
			}
			if err := copyFile(filepath.Join(dir, e.Name()), target); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
