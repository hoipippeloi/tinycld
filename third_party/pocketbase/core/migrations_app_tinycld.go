package core

import "sort"

// Fork: each app keeps its own list of JS migrations.
//
// Upstream registers every app migration in the process-global AppMigrations.
// A JS migration closes over the runtime of the app whose jsvm loaded it, so
// with several apps in one process each app's load added one more copy, and
// every app ran every app's copies. The jsvm loader registers into the app's
// own list instead. AppMigrations keeps the Go migrations, which are the same
// code for every app. See FORK.md.

const ownAppMigrationsStoreKey = "@tinycld.ownAppMigrations"

// OwnAppMigrations returns the list of migrations registered for app alone.
// It is created on first use and lives in the app's store.
func OwnAppMigrations(app App) *MigrationsList {
	return app.Store().GetOrSet(ownAppMigrationsStoreKey, func() any {
		return &MigrationsList{}
	}).(*MigrationsList)
}

// AppMigrationsOf returns every app migration app runs: AppMigrations and the
// app's own list, sorted by file name. It holds the registered *Migration
// values, so a ReapplyCondition survives.
func AppMigrationsOf(app App) MigrationsList {
	own := OwnAppMigrations(app)
	all := make([]*Migration, 0, len(AppMigrations.list)+len(own.list))
	all = append(all, AppMigrations.list...)
	all = append(all, own.list...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].File < all[j].File })
	return MigrationsList{list: all}
}
