package groups

import "testing"

func TestOnMembershipChange_RepeatIsIgnored(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	calls := 0
	listener := func(MembershipEvent) error {
		calls++
		return nil
	}
	OnMembershipChange("zoo.keepers", listener)
	OnMembershipChange("zoo.keepers", listener)

	notifyMembership(MembershipEvent{UserID: "u1", GroupID: "g1", Joined: true})
	if calls != 1 {
		t.Fatalf("listener ran %d times, want 1", calls)
	}
}
