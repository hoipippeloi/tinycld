package core

import "testing"

func TestAppMigrationsOf_MergesSortedAndKeepsTheRegisteredValues(t *testing.T) {
	saved := AppMigrations
	t.Cleanup(func() { AppMigrations = saved })
	AppMigrations = MigrationsList{}

	noop := func(App) error { return nil }
	reapply := func(App, *MigrationsRunner, string) (bool, error) { return true, nil }
	AppMigrations.Add(&Migration{File: "2_go.go", Up: noop, ReapplyCondition: reapply})

	app := NewBaseApp(BaseAppConfig{DataDir: t.TempDir()})
	OwnAppMigrations(app).Register(noop, nil, "3_js.js")
	OwnAppMigrations(app).Register(noop, nil, "1_js.js")

	list := AppMigrationsOf(app)
	var files []string
	for _, m := range list.Items() {
		files = append(files, m.File)
	}
	if len(files) != 3 || files[0] != "1_js.js" || files[1] != "2_go.go" || files[2] != "3_js.js" {
		t.Fatalf("AppMigrationsOf files = %v, want [1_js.js 2_go.go 3_js.js]", files)
	}
	if list.Item(1).ReapplyCondition == nil {
		t.Fatal("AppMigrationsOf dropped a Go migration's ReapplyCondition")
	}

	other := NewBaseApp(BaseAppConfig{DataDir: t.TempDir()})
	otherList := AppMigrationsOf(other)
	if got := len(otherList.Items()); got != 1 {
		t.Fatalf("another app sees %d migrations, want only the 1 Go migration", got)
	}
}
