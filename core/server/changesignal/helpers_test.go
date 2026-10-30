package changesignal

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// newZooApp is a test app with three fictional zoo collections and the
// change signal bound with the given window. zoo_feedings has a covering
// index on (animal, grams), so a query can read it through the index alone.
func newZooApp(t *testing.T, window time.Duration) *tests.TestApp {
	t.Helper()
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	for _, name := range []string{"zoo_animals", "zoo_keepers", "zoo_feedings"} {
		col := core.NewBaseCollection(name)
		col.Fields.Add(
			&core.TextField{Name: "name"},
			&core.TextField{Name: "animal"},
			&core.NumberField{Name: "grams"},
		)
		if name == "zoo_feedings" {
			col.AddIndex("idx_zoo_feedings_animal", false, "animal, grams", "")
		}
		if err := app.Save(col); err != nil {
			t.Fatalf("save %s: %v", name, err)
		}
	}
	register(app, window)
	return app
}

type listener struct {
	client *subscriptions.DefaultClient
}

// listen registers a realtime client subscribed to topic. A signed-in
// client carries an auth record, as the realtime subscribe request sets it.
func listen(t *testing.T, app core.App, topic string, signedIn bool) *listener {
	t.Helper()
	client := subscriptions.NewDefaultClient()
	if signedIn {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			t.Fatal(err)
		}
		client.Set(apis.RealtimeClientAuthKey, core.NewRecord(users))
	}
	client.Subscribe(topic)
	app.SubscriptionsBroker().Register(client)
	t.Cleanup(func() { app.SubscriptionsBroker().Unregister(client.Id()) })
	return &listener{client: client}
}

// collect returns every message that arrives within d.
func (l *listener) collect(d time.Duration) []subscriptions.Message {
	var got []subscriptions.Message
	deadline := time.After(d)
	for {
		select {
		case msg := <-l.client.Channel():
			got = append(got, msg)
		case <-deadline:
			return got
		}
	}
}

func saveAnimal(t *testing.T, app core.App, name string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("name", name)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save animal: %v", err)
	}
	return rec
}
