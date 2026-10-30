package changesignal

import (
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// TopicsRead returns, sorted, the topic of every collection a SELECT
// statement reads: a CTE, a subquery, an EXISTS and a covering index
// included, as CheckViews finds them. A client that shows the statement's
// result subscribes to these topics to know when to run it again. A system
// collection is left out: it sends no signal. A view's own topic is not
// listed, because SQLite reads the view's base tables, and their topics carry
// every change the view shows.
func TopicsRead(app core.App, query string, params dbx.Params) ([]string, error) {
	pages, err := rootPages(app)
	if err != nil {
		return nil, err
	}
	tables, err := tablesRead(app, pages, query, params)
	if err != nil {
		return nil, fmt.Errorf("changesignal: %w", err)
	}
	topics := make([]string, 0, len(tables))
	for _, table := range tables {
		col, err := app.FindCachedCollectionByNameOrId(table)
		if err != nil || col.System || col.Name != table {
			continue
		}
		topics = append(topics, Topic(col.Name))
	}
	return topics, nil
}
