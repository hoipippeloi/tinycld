package changesignal

import (
	"errors"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func rawInsertAnimal(t *testing.T, app core.App, id string) {
	t.Helper()
	_, err := app.DB().
		NewQuery("INSERT INTO zoo_animals (id, name) VALUES ({:id}, 'raw')").
		Bind(dbx.Params{"id": id}).
		Execute()
	if err != nil {
		t.Fatalf("raw insert: %v", err)
	}
}

func TestRawSQLWriteSendsNothingWithoutTouch(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rawInsertAnimal(t, app, "rawanimal000001")
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("raw write sent %d messages", len(got))
	}
}

func TestTouchSignalsTheCollectionAndItsViews(t *testing.T) {
	app := newZooApp(t, testWindow)
	RegisterView("zoo_fed", "zoo_animals")
	own := listen(t, app, "collection/zoo_animals", true)
	view := listen(t, app, "collection/zoo_fed", true)

	rawInsertAnimal(t, app, "rawanimal000002")
	Touch(app, "zoo_animals")
	if got := own.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("own topic: %d messages, want 1", len(got))
	}
	if got := view.collect(testWindow); len(got) != 1 {
		t.Fatalf("view topic: %d messages, want 1", len(got))
	}
}

func TestTouchInsideCommittedTransactionWaitsForTheCommit(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	var duringTx int
	err := app.RunInTransaction(func(tx core.App) error {
		rawInsertAnimal(t, tx, "rawanimal000003")
		Touch(tx, "zoo_animals")
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

func TestTouchInsideRolledBackTransactionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		rawInsertAnimal(t, tx, "rawanimal000004")
		Touch(tx, "zoo_animals")
		return errors.New("roll back")
	})
	if err == nil {
		t.Fatal("transaction did not fail")
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("rolled-back Touch sent %d messages", len(got))
	}
}

func TestTouchOfAnUnknownCollectionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_typo", true)

	Touch(app, "zoo_typo")
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("unknown collection sent %d messages", len(got))
	}
}

func TestTouchOfASystemCollectionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/_otps", true)

	Touch(app, "_otps")
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("system collection sent %d messages", len(got))
	}
}

func TestTouchWithoutRegisterIsANoOp(t *testing.T) {
	app := newZooApp(t, testWindow)
	app.Store().Remove(storeKey)
	Touch(app, "zoo_animals") // must not panic
}
