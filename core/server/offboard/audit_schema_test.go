package offboard

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/rlstest"
)

// The other offboard tests seed audit_logs with a plain text action field,
// which accepts any value. This one runs core's real migrations, where
// action is a select: a verb missing from it fails the save, and because the
// audit write is best-effort, the offboard still succeeds with no log row.
func TestOffboardUser_AuditRowSavesUnderRealSchema(t *testing.T) {
	for _, mode := range []Mode{ModeDeleteMyData, ModeReassign, ModeKeep} {
		t.Run(string(mode), func(t *testing.T) {
			app := rlstest.NewAssembledApp(t)
			leaver := makeMigratedUser(t, app, "leaver", "member")
			admin := makeMigratedUser(t, app, "admin", "admin")
			plan := Plan{Mode: mode}
			if mode == ModeReassign {
				plan.SuccessorUserID = admin.Id
			}
			if _, err := OffboardUser(app, leaver.Id, plan, admin.Id); err != nil {
				t.Fatalf("OffboardUser: %v", err)
			}
			rows, err := app.FindRecordsByFilter("audit_logs", "resource_id = {:uid}", "", 0, 0,
				map[string]any{"uid": leaver.Id})
			if err != nil {
				t.Fatalf("find audit rows: %v", err)
			}
			if len(rows) != 1 {
				t.Fatalf("audit rows for the leaver = %d, want 1", len(rows))
			}
		})
	}
}

func makeMigratedUser(t *testing.T, app core.App, username, role string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.SetEmail(username + "@test.local")
	u.Set("username", username)
	u.Set("name", username)
	u.Set("role", role)
	u.SetVerified(true)
	u.SetPassword("Password123!")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user %s: %v", username, err)
	}
	return u
}
