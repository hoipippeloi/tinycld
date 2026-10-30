package changesignal

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const testWindow = 50 * time.Millisecond

func TestCreateUpdateDeleteEachSignal(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rec := saveAnimal(t, app, "Leo")
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("create: %d messages, want 1", len(got))
	}
	rec.Set("name", "Leona")
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("update: %d messages, want 1", len(got))
	}
	if err := app.Delete(rec); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("delete: %d messages, want 1", len(got))
	}
}

func TestPayloadCarriesNoData(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rec := saveAnimal(t, app, "Leo")
	got := l.collect(4 * testWindow)
	if len(got) != 1 {
		t.Fatalf("%d messages, want 1", len(got))
	}
	if got[0].Name != "collection/zoo_animals" {
		t.Fatalf("name = %q", got[0].Name)
	}
	if string(got[0].Data) != "{}" {
		t.Fatalf("payload = %q, want {}", got[0].Data)
	}
	if strings.Contains(string(got[0].Data), rec.Id) || strings.Contains(string(got[0].Data), "Leo") {
		t.Fatalf("payload leaks record data: %q", got[0].Data)
	}
}

func TestRolledBackTransactionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		saveAnimal(t, tx, "Ghost")
		return errors.New("roll back")
	})
	if err == nil {
		t.Fatal("transaction did not fail")
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("rolled-back write sent %d messages", len(got))
	}
}

func TestSignalWaitsForTheCommit(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	var duringTx int
	err := app.RunInTransaction(func(tx core.App) error {
		saveAnimal(t, tx, "Slow")
		duringTx = len(l.collect(3 * testWindow))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if duringTx != 0 {
		t.Fatalf("%d messages before the commit", duringTx)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("after commit: %d messages, want 1", len(got))
	}
}

func TestBatchInOneTransactionSendsOneMessage(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		for range 20 {
			saveAnimal(t, tx, "Herd")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("%d messages, want 1", len(got))
	}
}

func TestSeparateWritesInOneWindowSendOneMessage(t *testing.T) {
	// A long window makes "inside one window" certain on a slow machine.
	app := newZooApp(t, time.Second)
	l := listen(t, app, "collection/zoo_animals", true)

	for range 5 {
		saveAnimal(t, app, "Burst")
	}
	if got := l.collect(1500 * time.Millisecond); len(got) != 1 {
		t.Fatalf("burst: %d messages, want 1", len(got))
	}
	saveAnimal(t, app, "Later")
	if got := l.collect(1500 * time.Millisecond); len(got) != 1 {
		t.Fatalf("next window: %d messages, want 1", len(got))
	}
}

func TestSteadyStreamIsNotStarved(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	// t.Fatal must not run on this goroutine (go vet: testinggoroutine).
	go func() {
		defer close(done)
		for range 12 {
			rec := core.NewRecord(col)
			rec.Set("name", "Stream")
			if err := app.Save(rec); err != nil {
				t.Errorf("save: %v", err)
				return
			}
			time.Sleep(testWindow / 4)
		}
	}()
	got := l.collect(3 * testWindow)
	<-done
	// Writes outlive the collect above, so the last window's send is still
	// due. Take it before the cleanup discards the client mid-send, which
	// the race detector reports.
	l.collect(3 * testWindow)
	if len(got) < 2 {
		t.Fatalf("%d messages in three windows of steady writes, want at least 2", len(got))
	}
}

func TestSkipsUnauthenticatedAndUnsubscribedClients(t *testing.T) {
	app := newZooApp(t, testWindow)
	signedOut := listen(t, app, "collection/zoo_animals", false)
	elsewhere := listen(t, app, "collection/zoo_keepers", true)

	saveAnimal(t, app, "Leo")
	if got := signedOut.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("signed-out client got %d messages", len(got))
	}
	if got := elsewhere.collect(testWindow); len(got) != 0 {
		t.Fatalf("client of another topic got %d messages", len(got))
	}
}

func TestViewTopicGetsItsSourcesWrites(t *testing.T) {
	app := newZooApp(t, testWindow)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings")
	view := listen(t, app, "collection/zoo_fed", true)

	saveAnimal(t, app, "Leo")
	if got := view.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("view topic: %d messages, want 1", len(got))
	}
}

func TestCollectionSchemaSaveSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	col.Fields.Add(&core.TextField{Name: "note"})
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("schema change sent %d messages", len(got))
	}
}
