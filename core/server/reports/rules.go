package reports

import (
	"fmt"
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
)

// ruleSelect returns the SELECT of the rows of col that the reader's list
// rule allows, built by PocketBase's own rule resolver exactly as the list
// API builds it: the rule's expression, the joins it needs (a back-relation,
// an @collection reference) and DISTINCT when it joined. The compiler puts it
// in a CTE, and every reference to the collection reads that CTE.
//
// A null rule (superusers only) selects nothing: a report never runs as a
// superuser. An empty rule (public) selects every row.
func ruleSelect(app core.App, col *core.Collection, info *core.RequestInfo) (string, dbx.Params, error) {
	q := app.DB().Select("{{" + col.Name + "}}.*").From(col.Name)
	switch {
	case col.ListRule == nil:
		q.AndWhere(dbx.NewExp("1=0"))
	case *col.ListRule != "":
		resolver := core.NewRecordFieldResolver(app, col, info, true)
		expr, err := search.FilterData(*col.ListRule).BuildExpr(resolver)
		if err != nil {
			return "", nil, fmt.Errorf("the list rule of %q cannot be built: %w", col.Name, err)
		}
		q.AndWhere(expr)
		if err := resolver.UpdateQuery(q); err != nil {
			return "", nil, fmt.Errorf("the list rule of %q cannot be built: %w", col.Name, err)
		}
	}
	built := q.Build()
	return built.SQL(), built.Params(), nil
}

// listRequestInfo is the request a list rule sees for a report: the reader,
// the request's headers, and a GET with no query or body, as a list request
// from the same client would carry.
func listRequestInfo(auth *core.Record, headers map[string]string) *core.RequestInfo {
	if headers == nil {
		headers = map[string]string{}
	}
	return &core.RequestInfo{
		Auth:    auth,
		Headers: headers,
		Query:   map[string]string{},
		Body:    map[string]any{},
		Method:  http.MethodGet,
		Context: core.RequestInfoContextDefault,
	}
}
