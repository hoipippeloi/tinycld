package apis

import (
	"github.com/pocketbase/pocketbase/tools/routine"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// realtimeSend delivers messages to one client.
//
// Stock PocketBase sends every message from its own goroutine, because
// DefaultClient.Send blocks on an unbuffered channel. Goroutines run in no
// fixed order, so two writes to one record in one transaction (a line
// created as a draft and posted before the commit) can reach the subscriber
// as the update followed by the create. The create carries the record as it
// was when it was written, so a subscriber that applies events as they
// arrive ends with the stale row.
//
// A ResumableClient queues without blocking, so its messages are sent inline
// and keep the order of the writes that produced them. Any other client is
// sent to from a goroutine, as before.
func realtimeSend(client subscriptions.Client, messages ...subscriptions.Message) {
	switch client.(type) {
	case *subscriptions.ResumableClient, *subscriptions.ResumableConn:
		for _, msg := range messages {
			client.Send(msg)
		}
	default:
		routine.FireAndForget(func() {
			for _, msg := range messages {
				client.Send(msg)
			}
		})
	}
}
