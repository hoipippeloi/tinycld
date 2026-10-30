package groups

import (
	"errors"
	"testing"
)

func TestRegisterGrantTableIsIdempotentAndIgnoresBlanks(t *testing.T) {
	ResetForTesting()
	RegisterGrantTable(GrantTable{Collection: "zoo_keepers", ResourceField: "zoo"})
	RegisterGrantTable(GrantTable{Collection: "zoo_keepers", ResourceField: "zoo"})
	RegisterGrantTable(GrantTable{Collection: "", ResourceField: "zoo"})
	RegisterGrantTable(GrantTable{Collection: "zoo_keepers", ResourceField: ""})

	got := RegisteredGrantTables()
	if len(got) != 1 || got[0].Collection != "zoo_keepers" || got[0].ResourceField != "zoo" {
		t.Fatalf("registry = %+v, want one zoo_keepers entry", got)
	}
}

// One package's failure must not keep a later package from hearing the
// event: every listener runs, in registration order.
func TestMembershipListenersAllRunInOrderAfterAnError(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	var seen []string
	OnMembershipChange("zoo.keepers", func(e MembershipEvent) error {
		seen = append(seen, "zoo:"+e.UserID)
		return errors.New("zoo keepers refused")
	})
	OnMembershipChange("acme.listener", func(e MembershipEvent) error {
		seen = append(seen, "acme:"+e.UserID)
		return nil
	})
	notifyMembership(MembershipEvent{UserID: "u1", GroupID: "g1", Joined: true})
	if len(seen) != 2 || seen[0] != "zoo:u1" || seen[1] != "acme:u1" {
		t.Fatalf("seen = %v, want both listeners in order", seen)
	}
}
