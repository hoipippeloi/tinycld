package changesignal

import (
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// zoo_fed reads zoo_feedings only in a subquery column (through the covering
// index) and zoo_keepers only in an EXISTS: the reads PocketBase's view
// parser does not see.
const zooFedQuery = `SELECT a.id, a.name,
	(SELECT SUM(f.grams) FROM zoo_feedings f WHERE f.animal = a.id) AS grams
	FROM zoo_animals a
	WHERE EXISTS (SELECT 1 FROM zoo_keepers k WHERE k.animal = a.id)`

func saveView(t *testing.T, app core.App, name, query string) {
	t.Helper()
	view := core.NewViewCollection(name)
	view.ViewQuery = query
	if err := app.Save(view); err != nil {
		t.Fatalf("save view %s: %v", name, err)
	}
}

func viewApp(t *testing.T) core.App {
	t.Helper()
	app := newZooApp(t, time.Second)
	saveView(t, app, "zoo_fed", zooFedQuery)
	saveView(t, app, "zoo_fed_named", `WITH c AS (SELECT animal, COUNT(*) n FROM zoo_feedings GROUP BY animal)
		SELECT v.id, v.name, c.n FROM zoo_fed v LEFT JOIN c ON c.animal = v.id`)
	return app
}

func TestCheckViewsPassesAFullDeclaration(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers")
	RegisterView("zoo_fed_named", "zoo_fed", "zoo_feedings")
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}

func TestCheckViewsNamesEveryUndeclaredRead(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals")
	err := CheckViews(app)
	if err == nil {
		t.Fatal("CheckViews passed a view that reads undeclared collections")
	}
	for _, want := range []string{
		`view "zoo_fed" reads "zoo_feedings"`,
		`view "zoo_fed" reads "zoo_keepers"`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), `reads "zoo_animals"`) {
		t.Errorf("error names a declared source: %q", err)
	}
}

func TestCheckViewsCountsARegisteredViewsSources(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers")
	RegisterView("zoo_fed_named", "zoo_fed")
	// zoo_fed_named reads zoo_feedings itself too (the CTE), and zoo_fed
	// covers it, so this passes.
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}

func TestCheckViewsRefusesAnUnknownSource(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers", "zoo_typo")
	err := CheckViews(app)
	if err == nil || !strings.Contains(err.Error(), `view "zoo_fed" declares "zoo_typo", which is not a collection`) {
		t.Fatalf("CheckViews = %v", err)
	}
}

func TestCheckViewsRefusesANonView(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_animals", "zoo_keepers")
	RegisterView("zoo_missing", "zoo_keepers")
	err := CheckViews(app)
	if err == nil {
		t.Fatal("CheckViews passed")
	}
	for _, want := range []string{
		`view "zoo_animals" is a base collection, not a view`,
		`view "zoo_missing" is not a collection`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

func TestCheckViewsWithNoViewsPasses(t *testing.T) {
	app := newZooApp(t, time.Second)
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}
