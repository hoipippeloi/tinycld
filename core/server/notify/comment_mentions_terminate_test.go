package notify

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// The mention notify runs after the request that wrote the mention row has
// answered. When the app terminates while it is still pushing, terminate must
// wait for it: the push path reads the database again (the stale-token
// delete), and a read after the database closes panics the whole process.
func TestCommentMention_TerminateWaitsForTheNotify(t *testing.T) {
	f := seedMentionFixture(t)

	users, err := f.app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	subs := core.NewBaseCollection("push_subscriptions")
	subs.Fields.Add(
		&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1},
		&core.TextField{Name: "platform"},
		&core.TextField{Name: "expo_token"},
		&core.TextField{Name: "endpoint"},
		&core.JSONField{Name: "keys"},
	)
	if err := f.app.Save(subs); err != nil {
		t.Fatal(err)
	}
	sub := core.NewRecord(subs)
	sub.Set("user", f.mentionUser.Id)
	sub.Set("platform", "expo")
	sub.Set("expo_token", "ExponentPushToken[gone]")
	if err := f.app.Save(sub); err != nil {
		t.Fatal(err)
	}

	hit := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case hit <- struct{}{}:
		default:
		}
		<-release
		// A gone device makes the notify delete its token: a database
		// write after the push, which must still find the database open.
		_, _ = w.Write([]byte(`{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}`))
	}))
	t.Cleanup(srv.Close)
	var releaseOnce sync.Once
	letGo := func() { releaseOnce.Do(func() { close(release) }) }
	// Runs before srv.Close (cleanups run last-in first-out), which would
	// otherwise wait forever on the held request after a failed assertion.
	t.Cleanup(letGo)
	prev := expoPushURL
	expoPushURL = srv.URL
	t.Cleanup(func() { expoPushURL = prev })

	registerCommentMentionHooksCore(f.app)
	cmCol, _ := f.app.FindCollectionByNameOrId("comment_mentions")
	mention := core.NewRecord(cmCol)
	mention.Set("comment_collection", "notepads_comments")
	mention.Set("comment_record", f.commentRoot.Id)
	mention.Set("drive_item", f.driveItem.Id)
	mention.Set("mentioned_user", f.mentionUser.Id)
	if err := f.app.Save(mention); err != nil {
		t.Fatal(err)
	}
	select {
	case <-hit:
	case <-time.After(10 * time.Second):
		t.Fatal("the mention notify never reached the push")
	}

	terminated := make(chan struct{})
	go func() {
		f.app.Cleanup()
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatal("terminate returned while the mention notify was still pushing")
	case <-time.After(300 * time.Millisecond):
	}

	stale, err := f.app.FindRecordById("push_subscriptions", sub.Id)
	if err != nil || stale == nil {
		t.Fatalf("the token was deleted before the push answered: %v", err)
	}
	letGo()
	select {
	case <-terminated:
	case <-time.After(10 * time.Second):
		t.Fatal("terminate did not return after the notify ended")
	}
}
