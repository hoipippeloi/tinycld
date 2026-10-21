package coreserver

import (
	"strconv"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/usernames"
)

// BackfillUsernames assigns a username to every users row that lacks one.
// Iteration order is creation-time stable; collisions resolve with numeric
// suffixes ("foo", "foo2", "foo3"). Used by the JS migration's parity check
// and any future re-backfill operation.
func BackfillUsernames(app core.App) error {
	rows, err := app.FindRecordsByFilter(
		"users", "username = ''", "created", 0, 0, nil,
	)
	if err != nil {
		return err
	}
	taken := map[string]bool{}
	all, err := app.FindRecordsByFilter("users", "username != ''", "", 0, 0, nil)
	if err != nil {
		return err
	}
	for _, r := range all {
		taken[r.GetString("username")] = true
	}
	for _, r := range rows {
		base := usernames.Derive(r.GetString("email"))
		candidate := base
		for i := 2; taken[candidate]; i++ {
			candidate = base + strconv.Itoa(i)
		}
		r.Set("username", candidate)
		taken[candidate] = true
		if err := app.Save(r); err != nil {
			return err
		}
	}
	return nil
}
