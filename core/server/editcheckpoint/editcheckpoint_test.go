package editcheckpoint

import (
	"context"
	"testing"
)

func TestFire_CallsRegisteredListener(t *testing.T) {
	t.Cleanup(ResetForTest)
	var gotID string
	var gotReason Reason
	var gotEditors Editors
	Register(func(_ context.Context, id string, e Editors, r Reason) {
		gotID, gotEditors, gotReason = id, e, r
	})
	Fire(context.Background(), "item1", Editors{UserIDs: []string{"u1"}}, ReasonIdle)
	if gotID != "item1" || gotReason != ReasonIdle || len(gotEditors.UserIDs) != 1 {
		t.Fatalf("got %q %q %+v", gotID, gotReason, gotEditors)
	}
}

func TestFire_NoListenerIsNoop(t *testing.T) {
	t.Cleanup(ResetForTest)
	ResetForTest()
	Fire(context.Background(), "item1", Editors{}, ReasonIdle)
}

func TestEditors_Empty(t *testing.T) {
	if !(Editors{}).Empty() {
		t.Fatal("zero Editors should be empty")
	}
	if (Editors{ShareNames: []string{"Anon Otter"}}).Empty() {
		t.Fatal("an anonymous editor is not empty")
	}
}
