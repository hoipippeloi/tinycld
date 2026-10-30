package changesignal

import (
	"reflect"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
)

func TestTopicsReadNamesEveryCollectionAStatementReads(t *testing.T) {
	app := newZooApp(t, time.Second)
	// zoo_keepers is read only inside a CTE and zoo_feedings only in an
	// EXISTS through its covering index; the bound value must not matter.
	query := `WITH k AS (SELECT animal FROM zoo_keepers WHERE name = {:keeper})
		SELECT a.id FROM zoo_animals a
		WHERE a.id IN (SELECT animal FROM k)
		AND EXISTS (SELECT 1 FROM zoo_feedings f WHERE f.animal = a.id AND f.grams > 0)`
	got, err := TopicsRead(app, query, dbx.Params{"keeper": "Ann"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"collection/zoo_animals", "collection/zoo_feedings", "collection/zoo_keepers"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TopicsRead = %v, want %v", got, want)
	}
}

func TestTopicsReadLeavesOutSystemCollections(t *testing.T) {
	app := newZooApp(t, time.Second)
	got, err := TopicsRead(app, "SELECT a.id FROM zoo_animals a, _superusers s WHERE s.id = a.name", nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"collection/zoo_animals"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("TopicsRead = %v, want %v", got, want)
	}
}

func TestTopicsReadReportsAStatementThatDoesNotCompile(t *testing.T) {
	app := newZooApp(t, time.Second)
	if _, err := TopicsRead(app, "SELECT nope FROM zoo_animals", nil); err == nil {
		t.Fatal("TopicsRead accepted a statement SQLite cannot compile")
	}
}
