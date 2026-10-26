package apis_test

import (
	"encoding/json"
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// A record created and then updated in one transaction must reach a
// subscription as a create followed by an update, in that order. A subscriber
// that lands events as they arrive otherwise keeps the create's stale payload.
func TestRealtimeSameTransactionEventOrder(t *testing.T) {
	testApp, _ := tests.NewTestApp()
	defer testApp.Cleanup()

	if _, err := apis.NewRouter(testApp); err != nil {
		t.Fatal(err)
	}

	collection := newLeaveCollection(t, testApp, "test_order", "@request.auth.id != ''")

	user, err := testApp.FindAuthRecordByEmail("users", "test@example.com")
	if err != nil {
		t.Fatal(err)
	}

	// Several subscribers, as a server with a few open pages has.
	var conns []*subscriptions.ResumableConn
	for c := 0; c < 3; c++ {
		client := subscriptions.NewResumableClient(subscriptions.ResumableOptions{
			MaxMessages: 1000, MaxBytes: 1 << 20, MaxPending: 1000,
		})
		client.Set(apis.RealtimeClientAuthKey, user)
		client.Subscribe(leaveTopic("test_order/*", "status = 'posted'"))
		testApp.SubscriptionsBroker().Register(client)
		conn, ok := client.Attach(0)
		if !ok {
			t.Fatal("attach refused")
		}
		conns = append(conns, conn)
	}

	// Background CPU load, as other requests and GC produce on a busy server.
	stop := make(chan struct{})
	defer close(stop)
	for w := 0; w < runtime.NumCPU(); w++ {
		go func() {
			x := 0
			for {
				select {
				case <-stop:
					return
				default:
					x++
					if x%1000 == 0 {
						runtime.Gosched()
					}
				}
			}
		}()
	}

	const runs = 3000
	reordered, staleCreates, sameUpdated := 0, 0, 0
	for i := 0; i < runs; i++ {
		err := testApp.RunInTransaction(func(tx core.App) error {
			rec := core.NewRecord(collection)
			rec.Set("status", "draft")
			if err := tx.Save(rec); err != nil {
				return err
			}
			fresh, err := tx.FindRecordById(collection.Name, rec.Id)
			if err != nil {
				return err
			}
			fresh.Set("status", "posted")
			return tx.Save(fresh)
		})
		if err != nil {
			t.Fatal(err)
		}

		for _, conn := range conns {
			var actions, statuses, updatedAt []string
			deadline := time.After(2 * time.Second)
			for len(actions) < 2 {
				select {
				case msg := <-conn.Channel():
					var decoded leaveMessage
					_ = json.Unmarshal(msg.Data, &decoded)
					actions = append(actions, decoded.Action)
					statuses = append(statuses, fmt.Sprint(decoded.Record["status"]))
					updatedAt = append(updatedAt, fmt.Sprint(decoded.Record["updated"]))
				case <-deadline:
					t.Fatalf("run %d: received only %v", i, actions)
				}
			}
			if actions[0] != "create" {
				reordered++
			}
			if updatedAt[0] == updatedAt[1] {
				sameUpdated++
			}
			for k, action := range actions {
				if action == "create" && statuses[k] != "posted" {
					staleCreates++
				}
			}
		}
	}

	t.Logf("runs=%d deliveries=%d update-before-create=%d create-payload-stale=%d same-updated-stamp=%d", runs, runs*len(conns), reordered, staleCreates, sameUpdated)
	if reordered > 0 {
		t.Fatalf("%d of %d runs delivered the update before the create", reordered, runs)
	}
}
