package apis

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"

	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// Realtime resume.
//
// Stock PocketBase drops a realtime client when its SSE request ends, so a
// reconnect gets a new client id and every event sent during the gap is
// lost. It also ends every connection on a schedule (IdleTimeout and
// MaxTimeout), so gaps are routine, not rare.
//
// Here a connection that ends leaves its client detached in the broker for
// realtimeResumeGrace. Events already queued for it stay queued (see
// subscriptions.ResumableClient). Each event payload carries a per-client
// "seq". A reconnect with `?resume=<clientId>&after=<seq>` gets the same
// client back, `"resumed":true` in PB_CONNECT and the queued events, with no
// subscriptions POST.
//
// A create or update broadcast does not rule-check a detached client: it only
// notes the record (realtimeDeferChange). The broadcast runs inside the write
// request, and many detached clients never resume, so checking every
// subscription of every one of them made each write slower for the whole
// grace period. The resume sends each noted record as it is then,
// rule-checked as a live broadcast is (realtimeDrainDeferred). A
// delete is still rule-checked when it happens, because afterwards the record
// is gone and nothing could tell which subscriptions saw it.
//
// A subscriber that will not resume a client (a page being reloaded or
// closed, a sign-out) releases it with `POST /api/realtime/release`
// (realtimeRelease), so the client does not wait out the grace period.
//
// The SSE request carries the subscriber's Authorization header, so a resume
// is bound to the auth record stored by the client's subscriptions POST (and
// to its IP, as that POST is). A guest client never resumes: it has no auth
// record to bind to. Every refused resume falls back to a new client, which
// the subscriber treats as "reload everything".

// vars, not consts, so that tests can shorten them
var (
	// realtimeResumeGrace is how long a detached client is kept. Long
	// enough for a laptop lid or a train tunnel. Every detached client
	// still costs a rule check on each delete and on each write that can
	// change what a subscription sees, and not every abandoned client is
	// released (a crash, a mobile tab the OS ends, an e2e browser context
	// that closes without pagehide), so the bound is kept short.
	realtimeResumeGrace = 10 * time.Minute

	// realtimeResumeMaxMessages and realtimeResumeMaxBytes bound one
	// client's queue; past either the client cannot replay everything.
	realtimeResumeMaxMessages = 1000
	realtimeResumeMaxBytes    = 1 << 20
)

const (
	// realtimeResumeBudgetBytes bounds the queues of all detached clients
	// of one app.
	realtimeResumeBudgetBytes = 64 << 20

	// realtimeSubscribedKey marks a client whose subscriptions POST
	// succeeded. A client without one never resumes: the subscriber did not
	// get its topics confirmed, so it must reload after it reconnects.
	realtimeSubscribedKey = "tinycld.realtimeSubscribed"

	realtimeResumeBudgetStoreKey = "tinycld.realtimeResumeBudget"
	realtimeResumeRequestKey     = "tinycld.realtimeResume"
)

// realtimeResumeState is what a connect request knows about its resume.
type realtimeResumeState struct {
	candidate *subscriptions.ResumableClient
	after     uint64
	resumed   bool
}

// realtimeNewClient creates the client of a new realtime connection.
func realtimeNewClient(e *core.RequestEvent) *subscriptions.ResumableClient {
	app := e.App
	budget := app.Store().GetOrSet(realtimeResumeBudgetStoreKey, func() any {
		return subscriptions.NewQueueBudget(realtimeResumeBudgetBytes)
	}).(*subscriptions.QueueBudget)

	return subscriptions.NewResumableClient(subscriptions.ResumableOptions{
		MaxMessages: realtimeResumeMaxMessages,
		MaxBytes:    realtimeResumeMaxBytes,
		MaxPending:  realtimeResumeMaxMessages,
		Budget:      budget,
		OnOverflow: func(client *subscriptions.ResumableClient) {
			app.SubscriptionsBroker().Unregister(client.Id())
		},
	})
}

// realtimeConnectClient returns the client of a connect request: the client
// it may resume, or a new one. It does not attach yet, because the connect
// hooks may still reject the request.
func realtimeConnectClient(e *core.RequestEvent) subscriptions.Client {
	query := e.Request.URL.Query()

	clientId := query.Get("resume")
	if clientId == "" {
		return realtimeNewClient(e)
	}

	var after uint64
	if raw := query.Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return realtimeNewClient(e)
		}
		after = parsed
	}

	existing, err := e.App.SubscriptionsBroker().ClientById(clientId)
	if err != nil {
		return realtimeNewClient(e)
	}

	client, ok := existing.(*subscriptions.ResumableClient)
	if !ok || !realtimeCanResume(e, client) {
		return realtimeNewClient(e)
	}

	e.Set(realtimeResumeRequestKey, &realtimeResumeState{candidate: client, after: after})

	return client
}

// realtimeCanResume reports whether the request may take over the client.
func realtimeCanResume(e *core.RequestEvent, client *subscriptions.ResumableClient) bool {
	if subscribed, _ := client.Get(realtimeSubscribedKey).(bool); !subscribed {
		return false
	}

	clientAuth, _ := client.Get(RealtimeClientAuthKey).(*core.Record)
	if clientAuth == nil || !isSameAuth(clientAuth, e.Auth) {
		return false
	}

	clientIP, _ := client.Get(RealtimeClientIPKey).(string)

	return clientIP == e.RealIP()
}

// realtimeRegisterClient registers the connection's client and attaches the
// connection to it, resuming the candidate when it still can be.
func realtimeRegisterClient(ce *core.RealtimeConnectRequestEvent) {
	broker := ce.App.SubscriptionsBroker()

	state, _ := ce.Get(realtimeResumeRequestKey).(*realtimeResumeState)
	if state != nil && state.candidate == ce.Client {
		conn, ok := state.candidate.Attach(state.after)
		if ok {
			state.resumed = true
			ce.Client = conn
			// before PB_CONNECT is written, so that the subscriber cannot
			// change its subscriptions while they are read
			realtimeDrainDeferred(ce.App, state.candidate)
			return
		}

		// the subscriber missed messages that are no longer queued, so the
		// client can never resume again
		broker.Unregister(state.candidate.Id())

		client := realtimeNewClient(ce.RequestEvent)
		client.Set(RealtimeClientIPKey, ce.RealIP())
		ce.Client = client
	}

	client, ok := ce.Client.(*subscriptions.ResumableClient)
	if !ok {
		// a connect hook supplied its own client
		broker.Register(ce.Client)
		return
	}

	broker.Register(client)

	// a new client has sent nothing, so Attach(0) cannot be refused
	conn, _ := client.Attach(0)
	ce.Client = conn
}

// realtimeReleaseClient runs when the connection ends. It keeps a client
// that can resume detached, and unregisters any other.
func realtimeReleaseClient(app core.App, client subscriptions.Client) {
	conn, ok := client.(*subscriptions.ResumableConn)
	if !ok {
		app.SubscriptionsBroker().Unregister(client.Id())
		return
	}

	if !realtimeKeepDetached(conn) {
		app.SubscriptionsBroker().Unregister(conn.Id())
		return
	}

	if conn.Detach() {
		gen := conn.Gen()
		time.AfterFunc(realtimeResumeGrace, func() {
			if conn.Detached(gen) {
				app.SubscriptionsBroker().Unregister(conn.Id())
			}
		})
		return
	}

	// another connection attached since: it owns the client now
	if conn.IsDiscarded() {
		app.SubscriptionsBroker().Unregister(conn.Id())
	}
}

// realtimeKeepDetached reports whether a client whose connection ended
// could be resumed later.
func realtimeKeepDetached(conn *subscriptions.ResumableConn) bool {
	if conn.IsDiscarded() {
		return false
	}

	subscribed, _ := conn.Get(realtimeSubscribedKey).(bool)
	clientAuth, _ := conn.Get(RealtimeClientAuthKey).(*core.Record)

	return subscribed && clientAuth != nil
}

// realtimeConnectData is the PB_CONNECT payload.
func realtimeConnectData(ce *core.RealtimeConnectRequestEvent) []byte {
	data := `{"clientId":"` + ce.Client.Id() + `"`

	if state, _ := ce.Get(realtimeResumeRequestKey).(*realtimeResumeState); state != nil && state.resumed {
		data += `,"resumed":true`
	}

	return []byte(data + `}`)
}

func bindRealtimeResumeEvents(app core.App) {
	app.OnRealtimeSubscribeRequest().BindFunc(func(e *core.RealtimeSubscribeRequestEvent) error {
		err := e.Next()
		if err == nil {
			e.Client.Set(realtimeSubscribedKey, true)
		}

		return err
	})
}

// realtimeDeferChange notes a create or update for a detached client, in
// place of the access checks and the send (see the comment at the top of the
// file). It reports whether the broadcast must skip the client.
//
// visibleBefore is what the leave check found before the write; the resume
// needs it to tell a record that left a subscription from one the
// subscription never saw.
func realtimeDeferChange(
	client subscriptions.Client,
	action string,
	record *core.Record,
	visibleBefore map[string]struct{},
	dryCache bool,
) bool {
	if dryCache {
		return false
	}

	resumable, ok := client.(*subscriptions.ResumableClient)
	if !ok || !realtimeSubscribesTo(resumable, record) {
		return false
	}

	return resumable.Defer(record.Collection().Id, record.Id, action == "create", visibleBefore)
}

// realtimeSubscribesTo reports whether any subscription of the client can
// deliver the record.
func realtimeSubscribesTo(client subscriptions.Client, record *core.Record) bool {
	for prefix := range realtimeSubscriptionRuleMap(record) {
		if len(client.Subscriptions(prefix)) > 0 {
			return true
		}
	}

	return false
}

// realtimeDrainDeferred sends the changes the client deferred while it was
// detached, each record as it is now, until no change is left. A write that
// lands meanwhile is deferred too and sent by a later round, so the last
// state the subscriber gets is the record's last state.
func realtimeDrainDeferred(app core.App, client *subscriptions.ResumableClient) {
	for {
		changes := client.TakePending()
		if changes == nil {
			return
		}

		for _, change := range changes {
			realtimeSendDeferred(app, client, change)
		}
	}
}

func realtimeSendDeferred(app core.App, client *subscriptions.ResumableClient, change subscriptions.PendingChange) {
	record, err := app.FindRecordById(change.CollectionId, change.RecordId)
	if err != nil {
		// Deleted: the delete was rule-checked and queued when it happened,
		// for the subscriptions that saw the record then. One that the
		// record left before it was deleted still has to drop it.
		if !change.Created {
			realtimeSendGoneLeaves(app, client, change)
		}
		return
	}

	// A record the subscriber never received cannot leave anything.
	action := "update"
	leave := change.VisibleBefore
	if change.Created {
		action = "create"
		leave = nil
	}

	// The broadcast reads its clients from the app's broker. This one
	// holds only the resumed client, so the drain reuses the live access
	// checks, enrichment and leave messages as they are.
	broker := subscriptions.NewBroker()
	broker.Register(&realtimeDrainClient{Client: client, leaveKey: realtimeLeaveKey(record), leave: leave})

	err = realtimeBroadcastRecord(&realtimeDrainApp{App: app, broker: broker}, action, record, false)
	if err != nil {
		app.Logger().Debug(
			"Failed to send a deferred record change",
			slog.String("id", record.Id),
			slog.String("collectionName", record.Collection().Name),
			slog.String("error", err.Error()),
		)
	}
}

// realtimeSendGoneLeaves sends a leave for a deleted record to the
// subscriptions that saw it before a deferred write hid it.
func realtimeSendGoneLeaves(app core.App, client subscriptions.Client, change subscriptions.PendingChange) {
	if len(change.VisibleBefore) == 0 {
		return
	}

	collection, err := app.FindCachedCollectionByNameOrId(change.CollectionId)
	if err != nil {
		return
	}

	record := core.NewRecord(collection)
	record.Id = change.RecordId

	realtimeSendLeaveMessages(app, client, change.VisibleBefore, record)
}

// realtimeDrainApp is the app of a drain broadcast: its broker holds only
// the client being drained.
type realtimeDrainApp struct {
	core.App
	broker *subscriptions.Broker
}

func (a *realtimeDrainApp) SubscriptionsBroker() *subscriptions.Broker {
	return a.broker
}

// realtimeDrainClient is the client of a drain broadcast. It hands the
// broadcast the deferred leave candidates, and it is not a ResumableClient,
// so realtimeDeferChange lets its sends through.
type realtimeDrainClient struct {
	subscriptions.Client
	leaveKey string
	leave    map[string]struct{}
}

func (c *realtimeDrainClient) Get(key string) any {
	if key == c.leaveKey {
		if c.leave == nil {
			return nil
		}
		return c.leave
	}

	return c.Client.Get(key)
}

func (c *realtimeDrainClient) Unset(key string) {
	if key == c.leaveKey {
		c.leave = nil
		return
	}

	c.Client.Unset(key)
}

type realtimeReleaseForm struct {
	ClientId string `form:"clientId" json:"clientId"`
}

// realtimeRelease removes a client its subscriber will not resume, such as
// the client of a page being closed or reloaded. Only the client's own auth
// record from the client's own IP can release it, as for a resume. The
// response is 204 in every case, so it does not tell whether a client exists.
func realtimeRelease(e *core.RequestEvent) error {
	form := new(realtimeReleaseForm)

	err := e.BindBody(form)
	if err != nil {
		return e.BadRequestError("", err)
	}

	err = validation.ValidateStruct(form,
		validation.Field(&form.ClientId, validation.Required, validation.Length(1, 255)),
	)
	if err != nil {
		return e.BadRequestError("", err)
	}

	broker := e.App.SubscriptionsBroker()

	client, err := broker.ClientById(form.ClientId)
	if err == nil {
		resumable, ok := client.(*subscriptions.ResumableClient)
		if ok && realtimeCanResume(e, resumable) {
			broker.Unregister(form.ClientId)
		}
	}

	return e.NoContent(http.StatusNoContent)
}
