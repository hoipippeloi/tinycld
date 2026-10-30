# Report Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A core Go report engine: packages register report sources, a versioned JSON report spec compiles to SQL on the PocketBase database with every collection filtered by the reader's own list rule, and `POST /api/reports/run` returns the result in the shell's row shape with the change-signal topics to listen to.

**Architecture:** A new package `tinycld.org/core/reports`. `RegisterSource` keeps the registry; `CheckSources` checks it against the database when the server starts. `Load` reads a spec (strict JSON, version upgrades, field aliases) and `Validate` binds it to the registry and compiles it without a database. A run builds one CTE per collection the statement reads from PocketBase's own rule resolver (`r<n>`), one rows CTE `w` (base rows, to-one joins, the filter, `exists` semi-joins, to-many totals per parent), then a group statement (every level as `GROUP BY` per level joined by `UNION ALL`, totals once per parent for to-many columns, pivot cells, layout rows) and a detail statement (keyset pages or the rows of expanded groups), plus a pivot pass and nested-row passes. Formulas compile from one tree to SQL; exact division and fiscal dates are Go functions registered in SQLite. `changesignal.TopicsRead` lists the topics from SQLite `EXPLAIN`.

**Tech Stack:** Go (PocketBase fork v0.40.4 at `tinycld/third_party/pocketbase`, modernc SQLite v1.57.0, `dbx`), TypeScript (vitest, zod) for one shared test, Biome.

**Spec:** `/Users/nas/code/tinycld/docs/superpowers/specs/2026-10-30-report-engine-design.md`, section "## 2. Report engine" (Source registry, The report spec, Spec versions, Compiler, Rules, Formulas, Money, Run endpoint) and the parts of "## Errors", "## Security" and "## Testing" that apply to it. Read-only: never edit anything under `/Users/nas/code/tinycld`.

**Repos and paths:**
- Workspace root: `/Users/nas/tmp/tinycld/books-purchases` (shortened below as `$WS`).
- Core repo: `$WS/tinycld`, branch `books/p5-report-engine`. Core Go module `tinycld.org/core` at `$WS/tinycld/core/server`; the new package is `$WS/tinycld/core/server/reports`.
- Binaries: call them from `$WS/node_modules/.bin` (`PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH`). `pnpm exec` starts a workspace install; do not use it. Do not run `pnpm install` or `packages:generate`; do not start servers.
- Go tests always build with `-tags no_ui` (`docs/packages.md`, "Test build tag": without it PocketBase panics on a duplicate admin UI route when test scenarios share an app, as the endpoint tests do).
- Do not touch the `books` member.

## Global Constraints

- The engine lives in core (`tinycld.org/core`). Packages register sources; core names no package. Tests use fictional `zoo_*` collections and `zoo.*` source keys. `pnpm run check:core-isolation` (`tsx scripts/check-core-isolation.ts`) stays green.
- Run endpoint: `POST /api/reports/run`, auth required. Body `{ spec, params, options }` (this unit); never SQL. Response `{ columns, rows, notices, topics, page }`. Errors: 400 with a field-level error list for an invalid spec; 422 for an unknown reference (names it); 408 on timeout. The endpoint is read-only and writes nothing.
- `rows` is the shell's `ReportModel` row shape: kind (`detail`, `group`, `subtotal`, `computed`, `total`), depth, group key, and cell values.
- A path stores the link at each hop; columns that share a path prefix share one join. Maximum depth: 4 hops.
- A to-many hop carries `mode`: `aggregate` (the column must have an aggregate; computed in a per-parent subquery) or `nest`. A sum across a to-many hop without `mode: aggregate` is a compile error ("sum across a to-many link would double-count").
- Each link hop may carry `with: "required" | "optional"` (inner or left join; default optional).
- Rule CTEs: for each collection the query touches, one CTE selects the rows the reader's list rule allows; every reference to that collection reads the CTE. The rule is built with `core.NewRecordFieldResolver` + `search.FilterData(rule).BuildExpr`. An empty rule is public, a null rule is superuser-only; a superuser token is never used to run a report.
- On a to-one link, a linked row the reader cannot see gives empty cells and keeps the parent row. On a to-many link, rows the reader cannot see are left out of aggregates and child rows.
- Pivot: first pass `SELECT DISTINCT <key> ... ORDER BY <key> LIMIT maxColumns + 1`; the row limit never applies before the pivot; when the cap is reached the result says how many values were left out.
- Group and pivot results are not paged; they are capped (default 5,000 result rows) and the result says when the cap applied. Detail rows page by keyset on the sort columns. A statement runs with a time limit (default 10 s); a stopped query returns a timeout error.
- Money is integer cents through every aggregate. `sum` uses SQLite `sum()`; an overflow is returned as "amount too large". `total()` and float `avg()` are never used for money. Division takes an explicit `scale` and rounds half away from zero with integer arithmetic (the shell's `roundedQuotient` rule).
- A sum over rows with more than one currency groups by currency instead of mixing them; the result marks such columns.
- Formulas are one tree `{ op, args }` with leaves `{ col }`, `{ path }`, `{ param }`, `{ value }`, `{ subtotal }`, compiled to SQL; gaps are Go functions registered in SQLite. The forms engine evaluator (TS and Go) and the report compiler share one formula test table.
- Go code logs through `logging.ForPackage("reports")`; TS code uses no `console.*`, no `any`, no `biome-ignore`.
- Unreleased migrations: none in this unit (no schema change).

## Decisions this plan makes (read before Task 1)

1. **Rule CTEs come from PocketBase's resolver, exactly as the list API builds the list rule.** `ruleSelect` builds `SELECT <collection>.* FROM <collection>`, adds the rule's expression and lets `resolver.UpdateQuery` add the joins the rule needs (a back-relation or `@collection` reference becomes a `LEFT JOIN` plus `DISTINCT`). The resolver runs with `allowHiddenFields: true`, as `recordsList` does for the rule itself, so a rule reads related tables directly, not through their rules (PocketBase semantics). The joins stay inside the CTE; the probe proved parity with the list API for a back-relation rule, an `@collection` rule and core's `users` rule.
2. **The request a rule sees** is the reader as `@request.auth`, the request's own headers (snake case, first value, as PocketBase builds them), `GET`, context `default`, and no query or body: what a list request from the same client carries.
3. **One compiler, two modes.** `Validate` compiles every statement on a "dry" statement (no app): it checks formulas, filters, groups, the pivot cell and the layout, and needs no database. A run compiles the same code with the app. So a spec that passes `Validate` compiles at run time.
4. **Formula semantics follow the forms engine wherever both have the operator:** a blank operand counts as 0 in arithmetic, division by zero is 0, rounding is half away from zero, a sum of no rows is 0. `percentOfParent` and `percentOfTotal` (report-only) give no figure (NULL) when the whole is 0, as the shell's `formatReportPercent` shows nothing for a share of nothing. See "Decisions for the human".
5. **Type rules:** amount + amount (or a literal) is an amount; amount × number is an amount rounded to whole cents; amount × amount is refused; amount ÷ number is an amount and needs scale 0; amount ÷ amount is a ratio. An average of amounts needs scale 0. `eq`/`ne` compile to SQL `IS`/`IS NOT`, so a blank equals a blank. `not` of a condition on a blank is true. `contains` and `startsWith` ignore case.
6. **Whole numbers are SQLite integers.** PocketBase number columns have NUMERIC affinity, so a whole number is stored as an INTEGER and `sum()` adds integers exactly and raises "integer overflow" (probed). `tc_div` divides two integers with big-integer quotient and remainder; a REAL operand divides in float64 as the forms engine does.
7. **A column's aggregate is how it totals.** A path column without an aggregate is blank on group rows (its group key shows on its own group). A formula column with an aggregate totals its per-row value; a formula column without one is computed again from each group row's values (`margin = profit / total` per group). An aggregate inside a formula on a detail row is the aggregate of that one row.
8. **Aggregate locality for to-many totals:** a to-many total is computed per parent row; on group, subtotal and total rows it is totalled once per parent (`SELECT DISTINCT keys, parent, value`), so several base rows that share a parent never multiply it. A distinct count across a to-many link, and a to-many total of a money field that names a currency field, are refused (neither can be totalled correctly).
9. **Currencies:** every money column whose field names a currency field adds a currency key; every level (the total too) groups by the currency keys, so each group, subtotal and total row holds one currency. Cells carry `<colId>@currency`; a column with more than one currency on its total rows is marked `mixedCurrency` and a `mixedCurrency` notice lists it. A fixed currency (`Source.Currency`) is the column's `currency`. Total rows come in currency order.
10. **Groups load lazily.** A run returns the first level, plus the children of each group whose `groupKey` (its group values, then its currency values) is in `options.expand`; `options.expandAll` opens every group. Group rows carry their aggregates, so a closed group shows its figures. A subtotal row follows an open group whose `subtotals` is true. Windows (running sums, percents) are computed over every group of a level before the expansion filter, and over every detail row before paging.
11. **Row model:** `{ id, kind, depth, label, section?, parent?, groupKey?, expanded?, cells }`. This is the shell's `ReportModelRow` (`section` is the parent group row's id) with the spec's kinds: the shell's `section` kind is `group` here, and `computed` is new; `p5-report-builder` moves the shell and maps it. A row's label is its first column's value; a group row's label is its key (a select's label, "Yes"/"No", or `(none)` for a blank). Ids: `d:<id>`, `g:<groupKey JSON>`, `s:<groupKey JSON>`, `total` (`total:<currencies JSON>` with currency keys), `c:<row>`, and `<parent id>/<child id>` for nested rows.
12. **Layout computed rows are SQL**, in the group statement: one leg per computed row reads the first level's CTE (`o1`) for each section's value, per column and per pivot cell (the spec's "final CTE"). A computed row may read an earlier computed row by name. A section always shows its subtotal row. A layout report ends in its computed rows, not in an automatic total.
13. **Nested rows:** one chain of nest links per report; after a nest hop only to-one hops; no aggregate on a nested column; `with` does not apply to a nest hop. Each level is one query keyed by the parent ids of the level above.
14. **Topics come from SQLite `EXPLAIN`.** `changesignal.TopicsRead` (new, Task 2) maps every `OpenRead` root page of a statement to its table, as `CheckViews` does, so a collection read only inside a rule CTE (for example `zoo_keepers` through an `@collection` rule) is listed. System collections are left out.
15. **Unset params:** a param with no value and no default is unset. In a filter, a comparison on an unset param matches every row, so an empty filter chip filters nothing. Period presets resolve on the server against `options.today` (the reader's day; default today in UTC) and the base source's `FiscalStartMonth`. The fiscal year is named by the calendar year it ends in. Report dates are UTC days (the date part of the stored value).
16. **Sources are checked when the server starts** (`OnServe`, after migrations). A refused source is logged (`log.Error` reaches Sentry) and left out of `Sources()`; a spec that names it gets 422 `unknown_source`. Packages call `CheckSources` in their tests.
17. **Endpoint access:** `apis.RequireAuth("users")`, so a superuser token gets 403 and a report never runs as a superuser; `ErrNoReader` guards `Run` itself. OAuth bearer tokens are refused by oauth's default-deny (no scope covers a report that reads every package); a test pins that. Body limit 1 MB. `options.display` (the shell's Customize settings) is accepted and not read: formatting stays in the client. The `{ reportId }` form and its 403 belong to `p5-report-sharing`; this unit refuses any body field other than `spec`, `params`, `options`.
18. **No in-app help topic:** this unit adds no screen; `p5-report-builder` writes the help topic for building, sharing and publishing reports.

## Decisions for the human

1. **A formula that divides by zero, or by a blank.** The spec makes the forms engine and the report compiler pass one formula table "so the two languages give the same results". The forms engine is shipped and returns 0 for a division by zero and counts a blank as 0. A report cell of 0 for a margin with no sales can mislead; a blank cell is clearer. **Recommendation (this plan is built on it):** keep the forms result (0) for `div`, so the shared table holds, and give no figure (blank) for `percentOfParent` and `percentOfTotal`, as the shell already shows nothing for a share of nothing. A builder user who wants a blank wraps the formula in `if(eq(total, 0), null, div(...))`. Changing `div` to blank means changing the shipped forms engine first (stored computed values change), which is out of scope.

## What was probed (facts the tasks rely on)

Every probe ran as a real Go test in a scratch package under `core/server` (deleted before the plan was committed). Every task below was also built in order in a scratch copy of the package: each task's test file fails on the previous task's code and passes on its own (the expected failures quoted in each Step 2 are that run's output).

- **Rule CTE parity:** `ruleSelect` output (for the `@collection` rule of `zoo_feedings`: `SELECT DISTINCT zoo_feedings.* FROM zoo_feedings LEFT JOIN zoo_keepers __collection_zoo_keepers WHERE ([[__collection_zoo_keepers.user]] = {:f…} AND COALESCE(…) = COALESCE(…))`) embedded as `WITH r AS (…) SELECT id FROM r` returned exactly the list API ids for two users on `users`, `zoo_sites`, `zoo_animals` (back-relation rule), `zoo_keepers` and `zoo_feedings`. Two rule CTEs in one statement do not collide: the resolver names placeholders `f` + 10 random characters.
- **dbx:** `SelectQuery.Build().SQL()` keeps `[[col]]` and `{:name}` placeholders, and `app.DB().NewQuery(sql).Bind(params)` processes them in the bigger statement.
- **Go functions in SQLite:** `sqlite.MustRegisterDeterministicScalarFunction` in a package `init()` is on every connection the test app opens; arguments arrive as `int64`, `float64`, `string` or `nil`; a returned Go error reaches the query as `SQL logic error: <message> (1)`.
- **Integer storage and overflow:** a number field set to 190 reads back `int64` (`typeof` = integer), 12.5 reads `float64`; `sum()` over `9223372036854775807` and `1` fails with `*sqlite.Error` "SQL logic error: integer overflow (1)".
- **Time limit:** `NewQuery(...).WithContext(ctx)` with a 50 ms deadline stopped an endless recursive CTE after 51 ms with an error for which `errors.Is(err, context.DeadlineExceeded)` is true. An already-expired context fails the same way, which the timeout tests use.
- **Window functions** (`SUM(x) OVER (PARTITION BY … ORDER BY … ROWS UNBOUNDED PRECEDING)`) run in the bundled SQLite.
- **`EXPLAIN` with bound parameters** maps `OpenRead` root pages to tables through a CTE, an `EXISTS` and a covering index (Task 2 tests).
- **Composition:** binding `reports.Register(app)` in `RegisterSharedCore` moves exactly one golden count in `core/server/coreserver/composition_parity_test.go`: `OnServe` 36 → 37 (`TestRegisterBindsTheRecordedHandlerCounts` green with that change).
- **`re.RequestInfo()` reads the request body;** called after the handler decoded the body it fails, so the handler builds the rule headers itself (`ruleHeaders`).
- **`apis.RequireAuth("users")`** answers a superuser token with 403 "The authorized record is not allowed to perform this action."
- **Read-only mode** (`core/server/readonly`) refuses every POST with 503 while a supervising process migrates; a run in that pause gets 503 and the client retries. No change here (see Concerns at the end).
- **Biome keeps a one-line JSON object on one line**, so the shared formula table is written one compact object per key (538 lines) and `biome check` passes as is.
- **Rule-parity fuzzing:** `go test -fuzz FuzzRuleParity -fuzztime 30s` ran 75,727 cases (random reader, source, and/or filter over number and text fields, plus a to-one expand) with no difference from the list API.

## Review Focus

1. A reader whose list rule joins (a back-relation, an `@collection` reference) with a filter of nested `and`/`or` → the engine's rows are exactly the list API's rows for that reader (Task 16 `FuzzRuleParity`; Task 4 `TestRuleSelectMatchesTheListAPI`).
2. A grouped report with a to-many total and several base rows per parent (two feedings of one animal, each carrying the animal's keeper count) → each parent counts once on group and total rows (Task 10 `TestAToManyTotalCountsEachParentOnce`).
3. Amounts past 2^53 and past the largest integer → totals stay exact past 2^53, and an overflow is "amount too large", never a rounded number (Task 10 `TestRunTotalsMoneyExactly`, `TestRunReportsAnAmountTooLarge`).
4. Detail pages over rows with blank sort values, with a row added between two page loads → no row twice, none skipped, blanks last (Task 11 `TestDetailRowsPageByKeyset`, `TestAPageStartsAfterItsCursorWhenRowsChange`).
5. A filter chip left empty (a param with no value) → the condition matches every row instead of none (Task 9 `TestAFilterOnAnUnsetParamMatchesEveryRow`).

---

### Task 1: SQLite functions for exact division and fiscal dates

**Files:**
- Create: `$WS/tinycld/core/server/reports/functions.go`
- Test: `$WS/tinycld/core/server/reports/functions_test.go`

**Interfaces:**
- Consumes: nothing (first file of the new package).
- Produces (package `reports`):
  - SQLite functions registered at `init()`: `tc_div(a, b, scale)`, `tc_pct(part, whole, scale)`, `tc_round(x, scale)`, `tc_fiscal_year(day, startMonth)`, `tc_fiscal_period(day, startMonth)`, `tc_add_months(day, n)`.
  - `const MaxScale = 6`; `var errOverflow` (text "integer overflow").
  - `func roundHalfAway(x float64, scale int) float64` (mirror of `core/server/forms/compute.go`).
  - Test helpers in `functions_test.go`: `newPlainApp(t *testing.T) *tests.TestApp`, `sqlValue(t, app core.App, expr string, params dbx.Params) (any, error)`. Task 6 reuses `newPlainApp`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/functions_test.go`:

```go
package reports

import (
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newPlainApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// sqlValue runs one SELECT expression through SQLite, so each case goes
// through the registered function exactly as compiled SQL calls it.
func sqlValue(t *testing.T, app core.App, expr string, params dbx.Params) (any, error) {
	t.Helper()
	var out struct {
		V any `db:"v"`
	}
	err := app.DB().NewQuery("SELECT " + expr + " AS v").Bind(params).One(&out)
	return out.V, err
}

func TestDivRoundsHalfAwayFromZeroExactly(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		name  string
		a, b  any
		scale int64
		want  any
	}{
		{"exact", int64(10), int64(2), 0, int64(5)},
		{"half up", int64(5), int64(2), 0, int64(3)},
		{"half away below zero", int64(-5), int64(2), 0, int64(-3)},
		{"negative divisor", int64(5), int64(-2), 0, int64(-3)},
		{"below half", int64(4), int64(3), 0, int64(1)},
		{"scale 2", int64(1), int64(3), 2, 0.33},
		{"scale 4 ratio", int64(1234), int64(5000), 4, 0.2468},
		{"near 2^53 stays exact", int64(9007199254740991), int64(2), 0, int64(4503599627370496)},
		{"zero divisor is 0", int64(7), int64(0), 2, int64(0)},
		{"real operand divides in float", 7.5, int64(2), 1, 3.8},
		{"real half away", 2.5, int64(1), 0, int64(3)},
		{"null in null out", nil, int64(2), 0, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := sqlValue(t, app, "tc_div({:a}, {:b}, {:s})", dbx.Params{"a": c.a, "b": c.b, "s": c.scale})
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("tc_div(%v, %v, %d) = %#v, want %#v", c.a, c.b, c.scale, got, c.want)
			}
		})
	}
}

func TestDivOverflowIsAnIntegerOverflowError(t *testing.T) {
	app := newPlainApp(t)
	_, err := sqlValue(t, app, "tc_div({:a}, 1, 0) * 1", dbx.Params{"a": int64(9223372036854775807)})
	if err != nil {
		t.Fatalf("a quotient that fits must not fail: %v", err)
	}
	_, err = sqlValue(t, app, "tc_pct({:a}, 1, 0)", dbx.Params{"a": int64(9223372036854775807)})
	if err == nil || !strings.Contains(err.Error(), "integer overflow") {
		t.Fatalf("err = %v, want integer overflow", err)
	}
}

func TestPctHasNoFigureWithoutAWhole(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		name        string
		part, whole any
		want        any
	}{
		{"quarter", int64(25), int64(100), 25.0},
		{"third at scale 1", int64(1), int64(3), 33.3},
		{"zero whole", int64(5), int64(0), nil},
		{"null whole", int64(5), nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := sqlValue(t, app, "tc_pct({:p}, {:w}, 1)", dbx.Params{"p": c.part, "w": c.whole})
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("tc_pct = %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestRoundKeepsIntegersAndRoundsReals(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		x     any
		scale int64
		want  any
	}{
		{int64(1234), 2, int64(1234)},
		{2.345, 2, 2.35},
		{-2.5, 0, int64(-3)},
		{nil, 0, nil},
	}
	for _, c := range cases {
		got, err := sqlValue(t, app, "tc_round({:x}, {:s})", dbx.Params{"x": c.x, "s": c.scale})
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("tc_round(%v, %d) = %#v, want %#v", c.x, c.scale, got, c.want)
		}
	}
}

func TestScaleOutOfRangeIsAnError(t *testing.T) {
	app := newPlainApp(t)
	for _, expr := range []string{"tc_div(1, 2, 7)", "tc_round(1.5, -1)", "tc_pct(1, 2, 'x')"} {
		if _, err := sqlValue(t, app, expr, nil); err == nil {
			t.Errorf("%s: no error", expr)
		}
	}
}

func TestFiscalYearAndPeriod(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		day          any
		start        int64
		year, period any
	}{
		{"2026-01-15 00:00:00.000Z", 1, int64(2026), int64(1)},
		{"2026-12-31", 1, int64(2026), int64(12)},
		{"2026-06-30", 7, int64(2026), int64(12)},
		{"2026-07-01 08:00:00.000Z", 7, int64(2027), int64(1)},
		{"2025-12-01", 4, int64(2026), int64(9)},
		{"", 7, nil, nil},
		{nil, 7, nil, nil},
	}
	for _, c := range cases {
		params := dbx.Params{"d": c.day, "m": c.start}
		year, err := sqlValue(t, app, "tc_fiscal_year({:d}, {:m})", params)
		if err != nil {
			t.Fatal(err)
		}
		period, err := sqlValue(t, app, "tc_fiscal_period({:d}, {:m})", params)
		if err != nil {
			t.Fatal(err)
		}
		if year != c.year || period != c.period {
			t.Errorf("%v start %d: year %#v period %#v, want %#v %#v", c.day, c.start, year, period, c.year, c.period)
		}
	}
	if _, err := sqlValue(t, app, "tc_fiscal_year('2026-01-01', 13)", nil); err == nil {
		t.Error("start month 13 must fail")
	}
}

func TestAddMonthsHoldsTheMonthEnd(t *testing.T) {
	app := newPlainApp(t)
	cases := []struct {
		day  any
		n    any
		want any
	}{
		{"2026-01-31", int64(1), "2026-02-28"},
		{"2024-01-31 00:00:00.000Z", int64(1), "2024-02-29"},
		{"2026-03-15", int64(-3), "2025-12-15"},
		{"2026-03-31", int64(12), "2027-03-31"},
		{"2026-03-31", nil, "2026-03-31"},
		{"", int64(1), nil},
	}
	for _, c := range cases {
		got, err := sqlValue(t, app, "tc_add_months({:d}, {:n})", dbx.Params{"d": c.day, "n": c.n})
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("tc_add_months(%v, %v) = %#v, want %#v", c.day, c.n, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL, `SQL logic error: no such function: tc_div (1)` (the package has only the test file).

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/functions.go`:

```go
package reports

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"math"
	"math/big"
	"time"

	sqlite "modernc.org/sqlite"
)

// The SQLite functions the compiled SQL calls where SQLite has no exact
// equivalent. The modernc driver adds a registered function to every
// connection it opens afterwards, so they register at package init, before
// PocketBase opens its database.
func init() {
	sqlite.MustRegisterDeterministicScalarFunction("tc_div", 3, sqlDiv)
	sqlite.MustRegisterDeterministicScalarFunction("tc_pct", 3, sqlPct)
	sqlite.MustRegisterDeterministicScalarFunction("tc_round", 2, sqlRound)
	sqlite.MustRegisterDeterministicScalarFunction("tc_fiscal_year", 2, sqlFiscalYear)
	sqlite.MustRegisterDeterministicScalarFunction("tc_fiscal_period", 2, sqlFiscalPeriod)
	sqlite.MustRegisterDeterministicScalarFunction("tc_add_months", 2, sqlAddMonths)
}

// errOverflow has the text SQLite's own sum() uses, so the run maps both to
// one "amount too large" error.
var errOverflow = errors.New("integer overflow")

// MaxScale is the most decimal places a division or rounding keeps. The
// forms engine's round takes 0 to 6, and the shared formula table pins both.
const MaxScale = 6

// sqlDiv is tc_div(a, b, scale): a / b rounded half away from zero at scale
// decimal places. Two integers divide exactly (big-integer quotient and
// remainder, the rule of the shell's roundedQuotient); a real operand divides
// in float64, as the forms engine does. Division by zero is 0, as in the forms
// engine. NULL in, NULL out: the compiler coalesces formula operands to 0.
// Scale 0 returns an INTEGER, a larger scale a REAL.
func sqlDiv(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	scale, err := scaleArg(args[2])
	if err != nil {
		return nil, err
	}
	if args[0] == nil || args[1] == nil {
		return nil, nil
	}
	return divide(args[0], args[1], scale)
}

// sqlPct is tc_pct(part, whole, scale): part as a percent of whole, rounded
// like tc_div. With no whole (NULL or zero) there is no figure, so NULL: the
// shell shows nothing for a share of nothing.
func sqlPct(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	scale, err := scaleArg(args[2])
	if err != nil {
		return nil, err
	}
	if args[0] == nil || args[1] == nil || isZero(args[1]) {
		return nil, nil
	}
	part, err := times100(args[0])
	if err != nil {
		return nil, err
	}
	return divide(part, args[1], scale)
}

// sqlRound is tc_round(x, scale): x rounded half away from zero. An integer
// is already exact at any scale.
func sqlRound(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	scale, err := scaleArg(args[1])
	if err != nil {
		return nil, err
	}
	switch x := args[0].(type) {
	case nil:
		return nil, nil
	case int64:
		return x, nil
	case float64:
		return floatResult(roundHalfAway(x, scale), scale)
	}
	return nil, fmt.Errorf("tc_round: %T is not a number", args[0])
}

// sqlFiscalYear is tc_fiscal_year(day, startMonth): the fiscal year a day
// falls in, named by the calendar year the fiscal year ends in. With a
// January start it is the calendar year.
func sqlFiscalYear(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	day, start, ok, err := fiscalArgs(args)
	if !ok || err != nil {
		return nil, err
	}
	year := int64(day.Year())
	if start > 1 && int(day.Month()) >= start {
		year++
	}
	return year, nil
}

// sqlFiscalPeriod is tc_fiscal_period(day, startMonth): the month of the
// fiscal year a day falls in, 1 to 12.
func sqlFiscalPeriod(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	day, start, ok, err := fiscalArgs(args)
	if !ok || err != nil {
		return nil, err
	}
	return int64((int(day.Month())-start+12)%12 + 1), nil
}

// sqlAddMonths is tc_add_months(day, n): the day n months later, held to the
// last day of a shorter month (Jan 31 + 1 month is Feb 28 or 29). SQLite's
// date(day, '+1 month') rolls over into the next month instead.
func sqlAddMonths(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	day, ok := parseDay(args[0])
	if !ok {
		return nil, nil
	}
	n, ok := args[1].(int64)
	if !ok {
		if args[1] != nil {
			return nil, fmt.Errorf("tc_add_months: %T is not a whole number of months", args[1])
		}
		n = 0
	}
	first := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, int(n), 0)
	last := first.AddDate(0, 1, -1).Day()
	return time.Date(first.Year(), first.Month(), min(day.Day(), last), 0, 0, 0, 0, time.UTC).Format(time.DateOnly), nil
}

func scaleArg(v driver.Value) (int, error) {
	s, ok := v.(int64)
	if !ok || s < 0 || s > MaxScale {
		return 0, fmt.Errorf("scale must be a whole number from 0 to %d", MaxScale)
	}
	return int(s), nil
}

func isZero(v driver.Value) bool {
	switch x := v.(type) {
	case int64:
		return x == 0
	case float64:
		return x == 0
	}
	return false
}

func times100(v driver.Value) (driver.Value, error) {
	switch x := v.(type) {
	case int64:
		if x > math.MaxInt64/100 || x < math.MinInt64/100 {
			return nil, errOverflow
		}
		return x * 100, nil
	case float64:
		return x * 100, nil
	}
	return nil, fmt.Errorf("%T is not a number", v)
}

func divide(a, b driver.Value, scale int) (driver.Value, error) {
	ai, aInt := a.(int64)
	bi, bInt := b.(int64)
	if aInt && bInt {
		if bi == 0 {
			return int64(0), nil
		}
		return bigResult(exactQuotient(big.NewInt(ai), big.NewInt(bi), scale), scale)
	}
	af, ok := toFloat(a)
	if !ok {
		return nil, fmt.Errorf("%T is not a number", a)
	}
	bf, ok := toFloat(b)
	if !ok {
		return nil, fmt.Errorf("%T is not a number", b)
	}
	if bf == 0 {
		return int64(0), nil
	}
	return floatResult(roundHalfAway(af/bf, scale), scale)
}

func toFloat(v driver.Value) (float64, bool) {
	switch x := v.(type) {
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// exactQuotient is a*10^scale / b rounded half away from zero, in integers.
func exactQuotient(a, b *big.Int, scale int) *big.Int {
	num := new(big.Int).Mul(a, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil))
	q, r := new(big.Int).QuoRem(num, b, new(big.Int))
	twice := new(big.Int).Mul(new(big.Int).Abs(r), big.NewInt(2))
	if twice.Cmp(new(big.Int).Abs(b)) >= 0 {
		if (num.Sign() < 0) != (b.Sign() < 0) {
			q.Sub(q, big.NewInt(1))
		} else {
			q.Add(q, big.NewInt(1))
		}
	}
	return q
}

func bigResult(q *big.Int, scale int) (driver.Value, error) {
	if scale == 0 {
		if !q.IsInt64() {
			return nil, errOverflow
		}
		return q.Int64(), nil
	}
	f, _ := new(big.Rat).SetFrac(q, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)).Float64()
	return f, nil
}

// roundHalfAway mirrors the forms engine (server/forms/compute.go): half away
// from zero, never -0, and 0 for a value that is not finite.
func roundHalfAway(x float64, scale int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	p := math.Pow10(scale)
	r := math.Round(math.Abs(x)*p) / p
	if r == 0 || math.IsInf(r, 0) {
		return 0
	}
	if x < 0 {
		return -r
	}
	return r
}

func floatResult(x float64, scale int) (driver.Value, error) {
	if scale > 0 {
		return x, nil
	}
	if x >= math.MaxInt64 || x < math.MinInt64 {
		return nil, errOverflow
	}
	return int64(x), nil
}

func fiscalArgs(args []driver.Value) (time.Time, int, bool, error) {
	start, ok := args[1].(int64)
	if !ok || start < 1 || start > 12 {
		return time.Time{}, 0, false, errors.New("fiscal start month must be 1 to 12")
	}
	day, ok := parseDay(args[0])
	return day, int(start), ok, nil
}

// parseDay reads the date part of a PocketBase date ("2026-01-31 00:00:00.000Z")
// or a plain day. Anything else, a blank date included, is no day.
func parseDay(v driver.Value) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || len(s) < len(time.DateOnly) {
		return time.Time{}, false
	}
	day, err := time.Parse(time.DateOnly, s[:len(time.DateOnly)])
	return day, err == nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: no gofmt or vet output; `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/functions.go \
  core/server/reports/functions_test.go
git commit -m "feat(core): reports SQLite functions for exact division and fiscal dates"
```

---

### Task 2: `changesignal.TopicsRead`: the topics a statement reads

**Files:**
- Create: `$WS/tinycld/core/server/changesignal/topics.go`
- Modify: `$WS/tinycld/core/server/changesignal/viewcheck.go` (`tablesRead` takes bound params)
- Test: `$WS/tinycld/core/server/changesignal/topics_test.go`

**Interfaces:**
- Consumes: `rootPages`, `tablesRead`, `Topic`, the test helper `newZooApp(t, window)` (all in package `changesignal`).
- Produces: `func TopicsRead(app core.App, query string, params dbx.Params) ([]string, error)` — sorted `collection/<name>` topics of every non-system collection the SELECT opens; an error when SQLite cannot compile it. `tablesRead` gains a `params dbx.Params` argument (`CheckViews` passes nil).

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/changesignal/topics_test.go`:

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/...`
Expected: FAIL to build: `undefined: TopicsRead`.

- [ ] **Step 3: Let `tablesRead` bind params**

In `$WS/tinycld/core/server/changesignal/viewcheck.go` make these three changes.

Add the import `"github.com/pocketbase/dbx"` above `"github.com/pocketbase/pocketbase/core"`.

Replace:

```go
	read, err := tablesRead(app, pages, "SELECT * FROM {{"+col.Name+"}}")
```

with:

```go
	read, err := tablesRead(app, pages, "SELECT * FROM {{"+col.Name+"}}", nil)
```

Replace:

```go
// tablesRead lists, sorted, the tables of the main database that query
// opens for reading.
func tablesRead(app core.App, pages map[int64]string, query string) ([]string, error) {
	var ops []struct {
		Opcode string `db:"opcode"`
		P2     int64  `db:"p2"`
		P3     int64  `db:"p3"`
	}
	if err := app.DB().NewQuery("EXPLAIN " + query).All(&ops); err != nil {
```

with:

```go
// tablesRead lists, sorted, the tables of the main database that query
// opens for reading. params binds the query's placeholders; EXPLAIN only
// compiles the statement, so their values do not change the result.
func tablesRead(app core.App, pages map[int64]string, query string, params dbx.Params) ([]string, error) {
	var ops []struct {
		Opcode string `db:"opcode"`
		P2     int64  `db:"p2"`
		P3     int64  `db:"p3"`
	}
	if err := app.DB().NewQuery("EXPLAIN " + query).Bind(params).All(&ops); err != nil {
```

- [ ] **Step 4: Write `TopicsRead`**

`$WS/tinycld/core/server/changesignal/topics.go`:

```go
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l changesignal && go vet -tags no_ui ./changesignal/... && go test -tags no_ui -count=1 ./changesignal/...`
Expected: no gofmt or vet output; `ok  tinycld.org/core/changesignal` (the `CheckViews` tests still pass).

- [ ] **Step 6: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/changesignal/topics.go \
  core/server/changesignal/topics_test.go \
  core/server/changesignal/viewcheck.go
git commit -m "feat(core): changesignal.TopicsRead lists the topics a statement reads"
```

---

### Task 3: The source registry

**Files:**
- Create: `$WS/tinycld/core/server/reports/registry.go`
- Test: `$WS/tinycld/core/server/reports/registry_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types `FieldType` (`Text`, `Number`, `Money`, `Date`, `DateTime`, `Bool`, `Select`, `Relation`, and `Percent` for formula results), `Aggregate` (`Sum`, `Count`, `CountDistinct`, `Min`, `Max`, `Avg`), sets `SumAll`, `MinMax`, `CountOnly`, `Cardinality` (`ToOne`, `ToMany`), `Option{Value, Label}`, `Field{Key, Column, Label, Type, Aggregates, Currency, Options}`, `Link{Key, Label, Target, Cardinality, Field, BackField}`, `Source{Key, Collection, Label, PrimaryKey, Fields, Links, Aliases, Currency func(core.App) string, FiscalStartMonth func(core.App) int}`.
  - `func RegisterSource(src Source)` (panics on a malformed source; adds the implicit `id` field), `func Sources() []Source`, `func Refused() map[string]string`, `func ResetForTesting()`.
  - Internal: `lookupSource(key string) *Source` (nil for unknown or refused), `(*Source).field(key) *Field`, `(*Source).link(key) *Link`, `(*Field).allows(a Aggregate) bool`; package vars `mu`, `sources`, `refused` (Task 4 fills `refused`).

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/registry_test.go`:

```go
package reports

import (
	"strings"
	"testing"
)

func validZooSource() Source {
	return Source{
		Key:        "zoo.feedings",
		Collection: "zoo_feedings",
		Label:      "Feedings",
		Fields: []Field{
			{Key: "cost", Label: "Cost", Type: Money, Aggregates: SumAll, Currency: "currency"},
			{Key: "currency", Label: "Currency", Type: Text},
			{Key: "fed", Label: "Fed", Type: Date, Aggregates: MinMax},
			{Key: "kind", Label: "Kind", Type: Select, Options: []Option{{Value: "hay", Label: "Hay"}}},
		},
		Links: []Link{
			{Key: "animal", Label: "Animal", Target: "zoo.animals", Cardinality: ToOne, Field: "animal"},
		},
		Aliases: map[string]string{"price": "cost"},
	}
}

func TestRegisterSourceAddsTheIDFieldAndDefaultColumns(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	src := validZooSource()
	RegisterSource(src)
	got := lookupSource("zoo.feedings")
	if got == nil {
		t.Fatal("source not registered")
	}
	if id := got.field("id"); id == nil || id.Type != Relation || !id.allows(Count) || id.allows(Sum) {
		t.Fatalf("id field = %+v", id)
	}
	if c := got.field("cost"); c.Column != "cost" {
		t.Fatalf("cost column = %q, want the key", c.Column)
	}
	if src.Fields[0].Column != "" {
		t.Fatal("RegisterSource changed the caller's field slice")
	}
	if l := got.link("animal"); l == nil || l.Cardinality != ToOne {
		t.Fatalf("animal link = %+v", l)
	}
}

func TestRegisterSourceReplacesTheSameKey(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	RegisterSource(validZooSource())
	again := validZooSource()
	again.Label = "Meals"
	RegisterSource(again)
	all := Sources()
	if len(all) != 1 || all[0].Label != "Meals" {
		t.Fatalf("Sources = %+v", all)
	}
}

func TestRegisterSourceRefusesMalformedSources(t *testing.T) {
	cases := map[string]struct {
		edit func(*Source)
		want string
	}{
		"key without package":    {func(s *Source) { s.Key = "feedings" }, "<package>.<name>"},
		"no collection":          {func(s *Source) { s.Collection = "" }, "collection"},
		"primary key":            {func(s *Source) { s.PrimaryKey = "code" }, "primary key"},
		"duplicate key":          {func(s *Source) { s.Links[0].Key = "cost" }, "used twice"},
		"unknown type":           {func(s *Source) { s.Fields[0].Type = "blob" }, "unknown type"},
		"sum of a date":          {func(s *Source) { s.Fields[2].Aggregates = SumAll }, "needs a number or money"},
		"select without options": {func(s *Source) { s.Fields[3].Options = nil }, "lists options"},
		"currency not text":      {func(s *Source) { s.Fields[0].Currency = "fed" }, "not a text field"},
		"no cardinality":         {func(s *Source) { s.Links[0].Cardinality = "" }, "cardinality"},
		"no target":              {func(s *Source) { s.Links[0].Target = "" }, "target source"},
		"to-many without back field": {func(s *Source) {
			s.Links[0].Cardinality = ToMany
		}, "BackField"},
		"to-one with back field": {func(s *Source) { s.Links[0].BackField = "x" }, "no BackField"},
		"alias still a key":      {func(s *Source) { s.Aliases = map[string]string{"cost": "fed"} }, "still a key"},
		"alias to nowhere":       {func(s *Source) { s.Aliases = map[string]string{"price": "nope"} }, "not a field or link"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			ResetForTesting()
			t.Cleanup(ResetForTesting)
			src := validZooSource()
			src.Fields = append([]Field(nil), src.Fields...)
			src.Links = append([]Link(nil), src.Links...)
			c.edit(&src)
			defer func() {
				r := recover()
				if r == nil {
					t.Fatal("RegisterSource did not panic")
				}
				if msg, _ := r.(string); !strings.Contains(msg, c.want) {
					t.Fatalf("panic %q does not mention %q", r, c.want)
				}
			}()
			RegisterSource(src)
		})
	}
}

// Core itself registers no source: every source belongs to a package.
func TestCoreRegistersNoSources(t *testing.T) {
	if got := Sources(); len(got) != 0 {
		t.Fatalf("core registered sources: %v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: Source`, `undefined: Field`, …

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/registry.go`:

```go
// Package reports is core's report engine. Packages register report sources
// (a collection, its fields and its links); a report spec picks a source and
// columns along those links, and the engine compiles it to one SQL statement
// per pass on the PocketBase database. Every collection the statement reads is
// filtered by the reader's own list rule, so a report never shows a number the
// reader's rules would hide.
//
// Core names no package; tests use fictional zoo_* collections.
package reports

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"sort"
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

// FieldType sets which formats and aggregates a field offers.
type FieldType string

const (
	Text     FieldType = "text"
	Number   FieldType = "number"
	Money    FieldType = "money" // integer cents
	Date     FieldType = "date"
	DateTime FieldType = "datetime"
	Bool     FieldType = "bool"
	Select   FieldType = "select"
	Relation FieldType = "relation" // a record id
	// Percent is never a field's type: percentOfParent and percentOfTotal
	// return it, and the shell formats it.
	Percent FieldType = "percent"
)

// Aggregate is how a column summarises in group, subtotal and total rows.
type Aggregate string

const (
	Sum           Aggregate = "sum"
	Count         Aggregate = "count"
	CountDistinct Aggregate = "countDistinct"
	Min           Aggregate = "min"
	Max           Aggregate = "max"
	Avg           Aggregate = "avg"
)

// Common aggregate sets. A field with no Aggregates can be counted.
var (
	SumAll    = []Aggregate{Sum, Avg, Min, Max, Count, CountDistinct}
	MinMax    = []Aggregate{Min, Max, Count, CountDistinct}
	CountOnly = []Aggregate{Count, CountDistinct}
)

// Cardinality says how many target rows a link reaches from one source row.
type Cardinality string

const (
	ToOne  Cardinality = "toOne"
	ToMany Cardinality = "toMany"
)

// Option is one choice of a Select field.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// Field is one column a report may show.
type Field struct {
	Key    string // stable; renaming it needs an alias
	Column string // the collection column; "" means Key
	Label  string
	Type   FieldType
	// Aggregates this field offers; nil means CountOnly.
	Aggregates []Aggregate
	// Currency, for a Money field, is the key of a Text field of the same
	// source that holds each row's currency code. "" uses Source.Currency.
	Currency string
	// Options label a Select field's values.
	Options []Option
}

// Link is a path from one source to another.
type Link struct {
	Key         string
	Label       string
	Target      string // the target source's key
	Cardinality Cardinality
	// Field is, for ToOne, the single relation column on this source.
	Field string
	// BackField is, for ToMany, the single relation column on the target
	// that points back at this source.
	BackField string
}

// Source is a collection a report can start from or reach through a link.
type Source struct {
	Key        string // "<package>.<name>", stable
	Collection string
	Label      string
	// PrimaryKey must be "" or "id": PocketBase relations point at id.
	PrimaryKey string
	Fields     []Field
	Links      []Link
	// Aliases maps an old field or link key to its new key, so a saved
	// report keeps working after a rename.
	Aliases map[string]string
	// Currency is the fixed currency of Money fields that name no Currency
	// field. nil means the currency is unknown to the engine.
	Currency func(app core.App) string
	// FiscalStartMonth (1-12) drives fiscalYear, fiscalPeriod and the
	// fiscal period presets when this source is a report's base. nil means 1.
	FiscalStartMonth func(app core.App) int
}

var (
	sourceKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`)
	memberKeyRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)
)

// idField is offered on every source, so a report can count linked rows.
var idField = Field{Key: "id", Column: "id", Label: "ID", Type: Relation, Aggregates: CountOnly}

var (
	mu      sync.RWMutex
	sources = map[string]*Source{}
	refused = map[string]string{}
)

// RegisterSource adds a package's source. Call it from the package's
// Register(app). Registering a key again replaces the source, so a dev
// reload does not duplicate it. A malformed source panics at boot: it is a
// wiring mistake in the package's code. What needs the database (the
// collection, its columns, its list rule) is checked when the server starts;
// see CheckSources.
func RegisterSource(src Source) {
	// The registry keeps its own copies: validation fills in default columns.
	src.Fields = slices.Clone(src.Fields)
	src.Links = slices.Clone(src.Links)
	src.Aliases = maps.Clone(src.Aliases)
	if err := validateSource(&src); err != nil {
		panic(fmt.Sprintf("reports.RegisterSource(%q): %v", src.Key, err))
	}
	if !slices.ContainsFunc(src.Fields, func(f Field) bool { return f.Key == idField.Key }) {
		src.Fields = append([]Field{idField}, src.Fields...)
	}
	mu.Lock()
	defer mu.Unlock()
	sources[src.Key] = &src
	delete(refused, src.Key)
}

func validateSource(src *Source) error {
	if !sourceKeyRe.MatchString(src.Key) {
		return fmt.Errorf("key must look like \"<package>.<name>\"")
	}
	if src.Collection == "" || src.Label == "" {
		return fmt.Errorf("a source needs a collection and a label")
	}
	if src.PrimaryKey != "" && src.PrimaryKey != "id" {
		return fmt.Errorf("primary key must be id: PocketBase relations point at id")
	}
	keys := map[string]bool{}
	claim := func(key string) error {
		if !memberKeyRe.MatchString(key) {
			return fmt.Errorf("invalid key %q", key)
		}
		if keys[key] {
			return fmt.Errorf("key %q is used twice", key)
		}
		keys[key] = true
		return nil
	}
	for i := range src.Fields {
		f := &src.Fields[i]
		if err := claim(f.Key); err != nil {
			return err
		}
		if f.Column == "" {
			f.Column = f.Key
		}
		if err := validateField(src, f); err != nil {
			return fmt.Errorf("field %q: %w", f.Key, err)
		}
	}
	for _, l := range src.Links {
		if err := claim(l.Key); err != nil {
			return err
		}
		if err := validateLink(l); err != nil {
			return fmt.Errorf("link %q: %w", l.Key, err)
		}
	}
	for from, to := range src.Aliases {
		if keys[from] {
			return fmt.Errorf("alias %q is still a key", from)
		}
		if !keys[to] && to != idField.Key {
			return fmt.Errorf("alias %q points at %q, which is not a field or link", from, to)
		}
	}
	return nil
}

func validateField(src *Source, f *Field) error {
	if f.Label == "" {
		return fmt.Errorf("a field needs a label")
	}
	switch f.Type {
	case Text, Number, Money, Date, DateTime, Bool, Select, Relation:
	default:
		return fmt.Errorf("unknown type %q", f.Type)
	}
	numeric := f.Type == Number || f.Type == Money
	for _, a := range f.Aggregates {
		switch a {
		case Sum, Avg:
			if !numeric {
				return fmt.Errorf("%s needs a number or money field", a)
			}
		case Count, CountDistinct, Min, Max:
		default:
			return fmt.Errorf("unknown aggregate %q", a)
		}
	}
	if (f.Type == Select) != (len(f.Options) > 0) {
		return fmt.Errorf("a select field, and only a select field, lists options")
	}
	if f.Currency != "" {
		if f.Type != Money {
			return fmt.Errorf("only a money field names a currency field")
		}
		i := slices.IndexFunc(src.Fields, func(c Field) bool { return c.Key == f.Currency })
		if i < 0 || src.Fields[i].Type != Text {
			return fmt.Errorf("currency field %q is not a text field of this source", f.Currency)
		}
	}
	return nil
}

func validateLink(l Link) error {
	if l.Label == "" || l.Target == "" {
		return fmt.Errorf("a link needs a label and a target source")
	}
	switch l.Cardinality {
	case ToOne:
		if l.Field == "" || l.BackField != "" {
			return fmt.Errorf("a to-one link names its relation Field and no BackField")
		}
	case ToMany:
		if l.BackField == "" || l.Field != "" {
			return fmt.Errorf("a to-many link names the target's BackField and no Field")
		}
	default:
		return fmt.Errorf("a link declares its cardinality (ToOne or ToMany)")
	}
	return nil
}

// Sources returns the sources a report may use, sorted by key: every
// registered source CheckSources has not refused.
func Sources() []Source {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Source, 0, len(sources))
	for key, src := range sources {
		if _, bad := refused[key]; !bad {
			out = append(out, *src)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// Refused returns the sources CheckSources refused, each with its reason.
func Refused() map[string]string {
	mu.RLock()
	defer mu.RUnlock()
	return maps.Clone(refused)
}

// lookupSource returns a usable source, or nil for an unknown or refused key.
func lookupSource(key string) *Source {
	mu.RLock()
	defer mu.RUnlock()
	if _, bad := refused[key]; bad {
		return nil
	}
	return sources[key]
}

// field and link find a member by key. They do not follow aliases.
func (s *Source) field(key string) *Field {
	for i := range s.Fields {
		if s.Fields[i].Key == key {
			return &s.Fields[i]
		}
	}
	return nil
}

func (s *Source) link(key string) *Link {
	for i := range s.Links {
		if s.Links[i].Key == key {
			return &s.Links[i]
		}
	}
	return nil
}

func (f *Field) allows(a Aggregate) bool {
	if f.Aggregates == nil {
		return slices.Contains(CountOnly, a)
	}
	return slices.Contains(f.Aggregates, a)
}

// ResetForTesting empties the registry. Tests register their own sources.
func ResetForTesting() {
	mu.Lock()
	defer mu.Unlock()
	sources = map[string]*Source{}
	refused = map[string]string{}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/registry.go \
  core/server/reports/registry_test.go
git commit -m "feat(core): report source registry"
```

---

### Task 4: Rule CTEs and `CheckSources`

**Files:**
- Create: `$WS/tinycld/core/server/reports/rules.go`, `$WS/tinycld/core/server/reports/check.go`
- Create (test fixture used by every later task): `$WS/tinycld/core/server/reports/zoo_test.go`
- Test: `$WS/tinycld/core/server/reports/rules_test.go`, `$WS/tinycld/core/server/reports/check_test.go`

**Interfaces:**
- Consumes: the registry (Task 3).
- Produces:
  - `func ruleSelect(app core.App, col *core.Collection, info *core.RequestInfo) (string, dbx.Params, error)` — the SELECT of the rows the list rule allows (nothing for a null rule, everything for an empty rule).
  - `func listRequestInfo(auth *core.Record, headers map[string]string) *core.RequestInfo`.
  - `func CheckSources(app core.App) error` — records refusals (`Refused()`), cascading through links.
  - Test fixture (`zoo_test.go`): `type zoo struct{ app *tests.TestApp; recs map[string]*core.Record }`; `newZoo(t testing.TB) *zoo` (core's assembled schema via `rlstest.NewAssembledApp`, five `zoo_*` collections, users ann and bob, records leo/zed/mo/kit, k1–k4, f1–f6, v1, and `registerZooSources()`); `registerZooSources()`; `rule(s string) *string`; `var zooFiscalStart`; methods `save`, `user`, `rec`, `feeding`, `as(name) *core.RequestInfo`, `id(key) string`, `token`, `mux(t) http.Handler` (the real router after `OnServe`), `listIDs(t, mux, collection, user, filter) []string`, `ids(keys...) []string`.

The fixture's data, which every later expectation reads:

```
users       ann, bob (role member)
zoo_sites   north (North, region north), south (South, region south)
zoo_animals leo  lion   site north owner ann weight 190 price 500000 born 2020-05-01 active
            zed  zebra  site south owner bob weight 300 price 120000 born 2019-02-10 active
            mo   monkey site north owner bob weight 12  price 30000  born 2022-08-15
            kit  cat    no site    owner ann weight 4   price 5000   active
zoo_keepers k1 ann→leo, k2 ann→zed, k3 bob→zed, k4 bob→mo
zoo_feedings (cost cents, USD; fed; grams; note = key)
            f1 leo 1000 2026-01-05 500   f2 leo 2500 2026-02-10 800
            f3 zed  700 2026-01-20 300   f4 zed  300 2026-03-03 100
            f5 mo   150 2026-02-14  50   f6 kit   99 2026-03-30  20
zoo_vault   v1 (list rule null)
ann sees animals leo, zed, kit; feedings f1-f4.   bob sees animals zed, mo; feedings f3, f4, f5.
```

- [ ] **Step 1: Write the fixture and the failing tests**

`$WS/tinycld/core/server/reports/zoo_test.go`:

```go
package reports

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/rlstest"
)

// The zoo: a fictional package's collections on core's real schema (the
// users collection and its rules come from core's migrations).
//
//	zoo_sites     list: any signed-in user
//	zoo_animals   list: the owner, or a keeper of the animal (back-relation)
//	zoo_keepers   list: the keeper themself
//	zoo_feedings  list: keepers of the fed animal (@collection rule)
//	zoo_vault     list: null (superusers only)
//
// Who sees what:
//
//	ann owns leo and kit and keeps leo and zed: animals leo, zed, kit;
//	    feedings f1, f2 (leo), f3, f4 (zed)
//	bob owns zed and mo and keeps zed and mo: animals zed, mo;
//	    feedings f3, f4 (zed), f5 (mo)
type zoo struct {
	app  *tests.TestApp
	recs map[string]*core.Record
}

func rule(s string) *string { return &s }

// zooFiscalStart is what the zoo.feedings source reports as its fiscal start
// month. A test that changes it restores it with t.Cleanup.
var zooFiscalStart = 1

func newZoo(t testing.TB) *zoo {
	t.Helper()
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	app := rlstest.NewAssembledApp(t)
	z := &zoo{app: app, recs: map[string]*core.Record{}}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	sites := core.NewBaseCollection("zoo_sites")
	sites.ListRule = rule(`@request.auth.id != ""`)
	sites.ViewRule = sites.ListRule
	sites.Fields.Add(
		&core.TextField{Name: "name"},
		&core.SelectField{Name: "region", Values: []string{"north", "south"}, MaxSelect: 1},
	)
	z.save(t, sites)

	animals := core.NewBaseCollection("zoo_animals")
	animals.Fields.Add(
		&core.TextField{Name: "name"},
		&core.TextField{Name: "species"},
		&core.RelationField{Name: "site", CollectionId: sites.Id, MaxSelect: 1},
		&core.RelationField{Name: "owner", CollectionId: users.Id, MaxSelect: 1},
		&core.NumberField{Name: "weight"},
		&core.NumberField{Name: "price"},
		&core.DateField{Name: "born"},
		&core.BoolField{Name: "active"},
		&core.TextField{Name: "secret", Hidden: true},
	)
	z.save(t, animals)

	keepers := core.NewBaseCollection("zoo_keepers")
	keepers.ListRule = rule(`user = @request.auth.id`)
	keepers.ViewRule = keepers.ListRule
	keepers.Fields.Add(
		&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1},
		&core.RelationField{Name: "animal", CollectionId: animals.Id, MaxSelect: 1},
	)
	z.save(t, keepers)

	// The back-relation needs zoo_keepers to exist first.
	animals.ListRule = rule(`owner = @request.auth.id || zoo_keepers_via_animal.user ?= @request.auth.id`)
	animals.ViewRule = animals.ListRule
	z.save(t, animals)

	feedings := core.NewBaseCollection("zoo_feedings")
	feedings.ListRule = rule(`@collection.zoo_keepers.user ?= @request.auth.id && @collection.zoo_keepers.animal ?= animal`)
	feedings.ViewRule = feedings.ListRule
	feedings.Fields.Add(
		&core.RelationField{Name: "animal", CollectionId: animals.Id, MaxSelect: 1},
		&core.NumberField{Name: "cost"},
		&core.TextField{Name: "currency"},
		&core.NumberField{Name: "grams"},
		&core.DateField{Name: "fed"},
		&core.TextField{Name: "note"},
	)
	z.save(t, feedings)

	vault := core.NewBaseCollection("zoo_vault")
	vault.Fields.Add(
		&core.TextField{Name: "name"},
		&core.RelationField{Name: "animal", CollectionId: animals.Id, MaxSelect: 1},
	)
	z.save(t, vault)

	ann := z.user(t, "ann")
	bob := z.user(t, "bob")
	north := z.rec(t, "north", "zoo_sites", map[string]any{"name": "North", "region": "north"})
	south := z.rec(t, "south", "zoo_sites", map[string]any{"name": "South", "region": "south"})
	leo := z.rec(t, "leo", "zoo_animals", map[string]any{"name": "Leo", "species": "lion", "site": north.Id, "owner": ann.Id, "weight": 190, "price": 500000, "born": "2020-05-01 00:00:00.000Z", "active": true})
	zed := z.rec(t, "zed", "zoo_animals", map[string]any{"name": "Zed", "species": "zebra", "site": south.Id, "owner": bob.Id, "weight": 300, "price": 120000, "born": "2019-02-10 00:00:00.000Z", "active": true})
	mo := z.rec(t, "mo", "zoo_animals", map[string]any{"name": "Mo", "species": "monkey", "site": north.Id, "owner": bob.Id, "weight": 12, "price": 30000, "born": "2022-08-15 00:00:00.000Z"})
	kit := z.rec(t, "kit", "zoo_animals", map[string]any{"name": "Kit", "species": "cat", "owner": ann.Id, "weight": 4, "price": 5000, "active": true})
	z.rec(t, "k1", "zoo_keepers", map[string]any{"user": ann.Id, "animal": leo.Id})
	z.rec(t, "k2", "zoo_keepers", map[string]any{"user": ann.Id, "animal": zed.Id})
	z.rec(t, "k3", "zoo_keepers", map[string]any{"user": bob.Id, "animal": zed.Id})
	z.rec(t, "k4", "zoo_keepers", map[string]any{"user": bob.Id, "animal": mo.Id})
	z.feeding(t, "f1", leo, 1000, "2026-01-05", 500)
	z.feeding(t, "f2", leo, 2500, "2026-02-10", 800)
	z.feeding(t, "f3", zed, 700, "2026-01-20", 300)
	z.feeding(t, "f4", zed, 300, "2026-03-03", 100)
	z.feeding(t, "f5", mo, 150, "2026-02-14", 50)
	z.feeding(t, "f6", kit, 99, "2026-03-30", 20)
	z.rec(t, "v1", "zoo_vault", map[string]any{"name": "Gold", "animal": leo.Id})

	registerZooSources()
	return z
}

func registerZooSources() {
	RegisterSource(Source{
		Key: "zoo.people", Collection: "users", Label: "People",
		Fields: []Field{{Key: "name", Label: "Name", Type: Text, Aggregates: MinMax}},
	})
	RegisterSource(Source{
		Key: "zoo.sites", Collection: "zoo_sites", Label: "Sites",
		Fields: []Field{
			{Key: "name", Label: "Name", Type: Text, Aggregates: MinMax},
			{Key: "region", Label: "Region", Type: Select, Options: []Option{{Value: "north", Label: "North"}, {Value: "south", Label: "South"}}},
		},
		Links: []Link{{Key: "animals", Label: "Animals", Target: "zoo.animals", Cardinality: ToMany, BackField: "site"}},
	})
	RegisterSource(Source{
		Key: "zoo.animals", Collection: "zoo_animals", Label: "Animals",
		Fields: []Field{
			{Key: "name", Label: "Name", Type: Text, Aggregates: MinMax},
			{Key: "species", Label: "Species", Type: Text, Aggregates: CountOnly},
			{Key: "weight", Label: "Weight", Type: Number, Aggregates: SumAll},
			{Key: "price", Label: "Price", Type: Money, Aggregates: SumAll},
			{Key: "born", Label: "Born", Type: Date, Aggregates: MinMax},
			{Key: "active", Label: "Active", Type: Bool},
		},
		Links: []Link{
			{Key: "site", Label: "Site", Target: "zoo.sites", Cardinality: ToOne, Field: "site"},
			{Key: "owner", Label: "Owner", Target: "zoo.people", Cardinality: ToOne, Field: "owner"},
			{Key: "feedings", Label: "Feedings", Target: "zoo.feedings", Cardinality: ToMany, BackField: "animal"},
			{Key: "keepers", Label: "Keepers", Target: "zoo.keepers", Cardinality: ToMany, BackField: "animal"},
		},
		Aliases:  map[string]string{"mass": "weight"},
		Currency: func(core.App) string { return "USD" },
	})
	RegisterSource(Source{
		Key: "zoo.feedings", Collection: "zoo_feedings", Label: "Feedings",
		Fields: []Field{
			{Key: "cost", Label: "Cost", Type: Money, Aggregates: SumAll, Currency: "currency"},
			{Key: "currency", Label: "Currency", Type: Text},
			{Key: "grams", Label: "Grams", Type: Number, Aggregates: SumAll},
			{Key: "fed", Label: "Fed", Type: Date, Aggregates: MinMax},
			{Key: "note", Label: "Note", Type: Text},
		},
		Links:            []Link{{Key: "animal", Label: "Animal", Target: "zoo.animals", Cardinality: ToOne, Field: "animal"}},
		FiscalStartMonth: func(core.App) int { return zooFiscalStart },
	})
	RegisterSource(Source{
		Key: "zoo.keepers", Collection: "zoo_keepers", Label: "Keepers",
		Links: []Link{
			{Key: "user", Label: "User", Target: "zoo.people", Cardinality: ToOne, Field: "user"},
			{Key: "animal", Label: "Animal", Target: "zoo.animals", Cardinality: ToOne, Field: "animal"},
		},
	})
	RegisterSource(Source{
		Key: "zoo.vault", Collection: "zoo_vault", Label: "Vault",
		Fields: []Field{{Key: "name", Label: "Name", Type: Text}},
		Links:  []Link{{Key: "animal", Label: "Animal", Target: "zoo.animals", Cardinality: ToOne, Field: "animal"}},
	})
}

func (z *zoo) save(t testing.TB, col *core.Collection) {
	t.Helper()
	if err := z.app.Save(col); err != nil {
		t.Fatalf("save %s: %v", col.Name, err)
	}
}

func (z *zoo) user(t testing.TB, name string) *core.Record {
	t.Helper()
	users, err := z.app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.SetEmail(name + "@zoo.test")
	u.SetPassword("password123")
	u.Set("role", "member")
	u.Set("name", name)
	u.Set("username", name)
	if err := z.app.Save(u); err != nil {
		t.Fatalf("save user %s: %v", name, err)
	}
	z.recs[name] = u
	return u
}

func (z *zoo) rec(t testing.TB, key, collection string, data map[string]any) *core.Record {
	t.Helper()
	col, err := z.app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatal(err)
	}
	r := core.NewRecord(col)
	for k, v := range data {
		r.Set(k, v)
	}
	if err := z.app.Save(r); err != nil {
		t.Fatalf("save %s: %v", key, err)
	}
	z.recs[key] = r
	return r
}

func (z *zoo) feeding(t testing.TB, key string, animal *core.Record, cost int, day string, grams int) *core.Record {
	t.Helper()
	return z.rec(t, key, "zoo_feedings", map[string]any{
		"animal": animal.Id, "cost": cost, "currency": "USD", "fed": day + " 00:00:00.000Z", "grams": grams, "note": key,
	})
}

// as is the list request a report run for this user resolves rules with.
func (z *zoo) as(name string) *core.RequestInfo {
	return listRequestInfo(z.recs[name], nil)
}

func (z *zoo) id(key string) string { return z.recs[key].Id }

func (z *zoo) token(t testing.TB, name string) string {
	t.Helper()
	token, err := z.recs[name].NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// mux is the app's real router with every OnServe route bound, as a request
// reaches it in production.
func (z *zoo) mux(t testing.TB) http.Handler {
	t.Helper()
	router, err := apis.NewRouter(z.app)
	if err != nil {
		t.Fatal(err)
	}
	var mux http.Handler
	err = z.app.OnServe().Trigger(&core.ServeEvent{App: z.app, Router: router}, func(e *core.ServeEvent) error {
		built, err := e.Router.BuildMux()
		mux = built
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return mux
}

// listIDs reads ids through PocketBase's list API as user, sorted.
func (z *zoo) listIDs(t testing.TB, mux http.Handler, collection, user, filter string) []string {
	t.Helper()
	q := url.Values{"perPage": {"500"}, "fields": {"id"}, "skipTotal": {"1"}}
	if filter != "" {
		q.Set("filter", filter)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/collections/"+collection+"/records?"+q.Encode(), nil)
	req.Header.Set("Authorization", z.token(t, user))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list %s as %s: %d %s", collection, user, rec.Code, rec.Body.String())
	}
	var body struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		ids = append(ids, item.ID)
	}
	sort.Strings(ids)
	return ids
}

// ids maps fixture keys to record ids, sorted.
func (z *zoo) ids(keys ...string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, z.id(k))
	}
	sort.Strings(out)
	return out
}
```

`$WS/tinycld/core/server/reports/rules_test.go`:

```go
package reports

import (
	"reflect"
	"testing"

	"github.com/pocketbase/dbx"
)

// ruleIDs runs the rule SELECT as a CTE, as the compiler uses it.
func ruleIDs(t *testing.T, z *zoo, collection, user string) []string {
	t.Helper()
	col, err := z.app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatal(err)
	}
	sql, params, err := ruleSelect(z.app, col, z.as(user))
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	if err := z.app.DB().NewQuery("WITH r AS (" + sql + ") SELECT id FROM r ORDER BY id").Bind(params).Column(&ids); err != nil {
		t.Fatalf("%s: %v", collection, err)
	}
	return ids
}

func TestRuleSelectMatchesTheListAPI(t *testing.T) {
	z := newZoo(t)
	mux := z.mux(t)
	// zoo_animals has a back-relation rule and zoo_feedings an @collection
	// rule: the resolver joins for both, and the joins stay inside the CTE.
	for _, user := range []string{"ann", "bob"} {
		for _, collection := range []string{"users", "zoo_sites", "zoo_animals", "zoo_keepers", "zoo_feedings"} {
			got := ruleIDs(t, z, collection, user)
			want := z.listIDs(t, mux, collection, user, "")
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s as %s: rule CTE %v, list API %v", collection, user, got, want)
			}
		}
	}
	if got, want := ruleIDs(t, z, "zoo_feedings", "ann"), z.ids("f1", "f2", "f3", "f4"); !reflect.DeepEqual(got, want) {
		t.Errorf("ann's feedings = %v, want %v", got, want)
	}
	if got, want := ruleIDs(t, z, "zoo_animals", "bob"), z.ids("zed", "mo"); !reflect.DeepEqual(got, want) {
		t.Errorf("bob's animals = %v, want %v", got, want)
	}
}

func TestRuleSelectOfANullRuleIsEmpty(t *testing.T) {
	z := newZoo(t)
	if got := ruleIDs(t, z, "zoo_vault", "ann"); len(got) != 0 {
		t.Fatalf("superuser-only collection gave a reader %v", got)
	}
}

func TestTwoRuleCTEsShareOneStatement(t *testing.T) {
	z := newZoo(t)
	feedings, _ := z.app.FindCollectionByNameOrId("zoo_feedings")
	animals, _ := z.app.FindCollectionByNameOrId("zoo_animals")
	fSQL, fParams, err := ruleSelect(z.app, feedings, z.as("bob"))
	if err != nil {
		t.Fatal(err)
	}
	aSQL, aParams, err := ruleSelect(z.app, animals, z.as("bob"))
	if err != nil {
		t.Fatal(err)
	}
	params := dbx.Params{}
	for _, p := range []dbx.Params{fParams, aParams} {
		for k, v := range p {
			params[k] = v
		}
	}
	var names []string
	err = z.app.DB().NewQuery("WITH r_f AS (" + fSQL + "), r_a AS (" + aSQL + `)
		SELECT a.name FROM r_f f JOIN r_a a ON a.id = f.animal ORDER BY f.cost`).Bind(params).Column(&names)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Mo", "Zed", "Zed"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
}
```

`$WS/tinycld/core/server/reports/check_test.go`:

```go
package reports

import (
	"strings"
	"testing"
)

func TestCheckSourcesPassesTheZoo(t *testing.T) {
	z := newZoo(t)
	if err := CheckSources(z.app); err != nil {
		t.Fatalf("CheckSources: %v", err)
	}
	if got := len(Sources()); got != 6 {
		t.Fatalf("%d sources, want 6", got)
	}
}

func TestCheckSourcesRefusesASourceThatDoesNotMatchTheSchema(t *testing.T) {
	cases := map[string]struct {
		src  Source
		want string
	}{
		"missing collection": {
			Source{Key: "zoo.ghosts", Collection: "zoo_ghosts", Label: "Ghosts"},
			`collection "zoo_ghosts" does not exist`,
		},
		"missing column": {
			Source{Key: "zoo.x", Collection: "zoo_animals", Label: "X", Fields: []Field{{Key: "tail", Label: "Tail", Type: Text}}},
			`column "tail" does not exist`,
		},
		"hidden column": {
			Source{Key: "zoo.x", Collection: "zoo_animals", Label: "X", Fields: []Field{{Key: "secret", Label: "Secret", Type: Text}}},
			`column "secret" is hidden from the API`,
		},
		"wrong type": {
			Source{Key: "zoo.x", Collection: "zoo_animals", Label: "X", Fields: []Field{{Key: "name", Label: "Name", Type: Money}}},
			`column "name" is a text field, which a money field cannot read`,
		},
		"select option not in the schema": {
			Source{Key: "zoo.x", Collection: "zoo_sites", Label: "X", Fields: []Field{{Key: "region", Label: "Region", Type: Select, Options: []Option{{Value: "east", Label: "East"}}}}},
			`option "east" is not a value`,
		},
		"to-one link through the wrong relation": {
			Source{Key: "zoo.x", Collection: "zoo_animals", Label: "X", Links: []Link{{Key: "site", Label: "Site", Target: "zoo.people", Cardinality: ToOne, Field: "site"}}},
			`relation "site" of "zoo_animals" does not point at "users"`,
		},
		"to-many link without a back relation": {
			Source{Key: "zoo.x", Collection: "zoo_sites", Label: "X", Links: []Link{{Key: "feedings", Label: "Feedings", Target: "zoo.feedings", Cardinality: ToMany, BackField: "note"}}},
			`"note" is not a relation field of "zoo_feedings"`,
		},
		"unregistered target": {
			Source{Key: "zoo.x", Collection: "zoo_animals", Label: "X", Links: []Link{{Key: "pen", Label: "Pen", Target: "zoo.pens", Cardinality: ToOne, Field: "site"}}},
			`target source "zoo.pens" is not registered`,
		},
		"system collection": {
			Source{Key: "zoo.x", Collection: "_superusers", Label: "X"},
			`is a system collection`,
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			z := newZoo(t)
			RegisterSource(c.src)
			err := CheckSources(z.app)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("CheckSources = %v, want it to contain %q", err, c.want)
			}
			if _, bad := Refused()[c.src.Key]; !bad {
				t.Fatalf("%s not refused", c.src.Key)
			}
			if lookupSource(c.src.Key) != nil {
				t.Fatal("a refused source is still usable")
			}
			if lookupSource("zoo.animals") == nil {
				t.Fatal("a sound source was refused")
			}
		})
	}
}

func TestCheckSourcesRefusesARuleThatCannotBeBuiltAndEveryLinkToIt(t *testing.T) {
	z := newZoo(t)
	// PocketBase validates a rule when the collection is saved, so a broken
	// rule can only arrive by a raw write; reload the cache so it is read.
	if _, err := z.app.DB().NewQuery("UPDATE _collections SET listRule = 'nope = 1' WHERE name = 'zoo_sites'").Execute(); err != nil {
		t.Fatal(err)
	}
	if err := z.app.ReloadCachedCollections(); err != nil {
		t.Fatal(err)
	}
	err := CheckSources(z.app)
	if err == nil || !strings.Contains(err.Error(), `the list rule of "zoo_sites" cannot be built`) {
		t.Fatalf("CheckSources = %v", err)
	}
	refusedNow := Refused()
	for _, key := range []string{"zoo.sites", "zoo.animals", "zoo.feedings", "zoo.keepers", "zoo.vault"} {
		if _, bad := refusedNow[key]; !bad {
			t.Errorf("%s is not refused", key)
		}
	}
	if !strings.Contains(refusedNow["zoo.animals"], `link "site" targets source "zoo.sites", which is refused`) {
		t.Errorf("zoo.animals reason = %q", refusedNow["zoo.animals"])
	}
	if _, bad := refusedNow["zoo.people"]; bad {
		t.Error("zoo.people links nowhere and must stay usable")
	}
}

func TestCheckSourcesAgainClearsAFixedRefusal(t *testing.T) {
	z := newZoo(t)
	RegisterSource(Source{Key: "zoo.ghosts", Collection: "zoo_ghosts", Label: "Ghosts"})
	if CheckSources(z.app) == nil {
		t.Fatal("expected a refusal")
	}
	RegisterSource(Source{Key: "zoo.ghosts", Collection: "zoo_sites", Label: "Ghosts"})
	if err := CheckSources(z.app); err != nil {
		t.Fatalf("CheckSources after the fix: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: CheckSources`, `undefined: ruleSelect`, `undefined: listRequestInfo`.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/rules.go`:

```go
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
```

`$WS/tinycld/core/server/reports/check.go`:

```go
package reports

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// CheckSources checks every registered source against the database: its
// collection and columns exist with matching types, no column is hidden from
// the API, each link follows a single relation to its target, and the
// collection's list rule can be built for a reader. A source that fails, or
// links to one that fails, is refused: Sources leaves it out and a report
// that names it gets an unknown-source error. The result names every refused
// source and why.
//
// The server runs it once at start, after migrations. A package calls it in
// its tests after its migrations apply, so a broken source fails there.
func CheckSources(app core.App) error {
	mu.Lock()
	defer mu.Unlock()
	refused = map[string]string{}
	keys := make([]string, 0, len(sources))
	for key := range sources {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if problems := checkSource(app, sources[key]); len(problems) > 0 {
			refused[key] = strings.Join(problems, "; ")
		}
	}
	// A link to a refused source is a broken link.
	for changed := true; changed; {
		changed = false
		for _, key := range keys {
			if _, bad := refused[key]; bad {
				continue
			}
			for _, l := range sources[key].Links {
				if reason, bad := refused[l.Target]; bad && sources[l.Target] != nil {
					refused[key] = fmt.Sprintf("link %q targets source %q, which is refused (%s)", l.Key, l.Target, reason)
					changed = true
					break
				}
			}
		}
	}
	if len(refused) == 0 {
		return nil
	}
	lines := make([]string, 0, len(refused))
	for _, key := range keys {
		if reason, bad := refused[key]; bad {
			lines = append(lines, fmt.Sprintf("source %q: %s", key, reason))
		}
	}
	return errors.New("reports: " + strings.Join(lines, "; "))
}

// checkSource runs under mu.
func checkSource(app core.App, src *Source) []string {
	col, err := app.FindCollectionByNameOrId(src.Collection)
	if err != nil {
		return []string{fmt.Sprintf("collection %q does not exist", src.Collection)}
	}
	if col.Name != src.Collection {
		return []string{fmt.Sprintf("collection %q must be named %q, not by id", col.Name, col.Name)}
	}
	if col.System {
		return []string{fmt.Sprintf("collection %q is a system collection", col.Name)}
	}
	var problems []string
	for _, f := range src.Fields {
		if msg := checkField(col, f); msg != "" {
			problems = append(problems, fmt.Sprintf("field %q: %s", f.Key, msg))
		}
	}
	for _, l := range src.Links {
		if msg := checkLink(app, src, col, l); msg != "" {
			problems = append(problems, fmt.Sprintf("link %q: %s", l.Key, msg))
		}
	}
	if msg := checkRule(app, col); msg != "" {
		problems = append(problems, msg)
	}
	return problems
}

func checkField(col *core.Collection, f Field) string {
	if f.Column == "id" {
		if f.Type != Relation && f.Type != Text {
			return "the id column is a relation or text field"
		}
		return ""
	}
	pf := col.Fields.GetByName(f.Column)
	if pf == nil {
		return fmt.Sprintf("column %q does not exist", f.Column)
	}
	if pf.GetHidden() {
		return fmt.Sprintf("column %q is hidden from the API", f.Column)
	}
	if !slices.Contains(compatible[f.Type], pf.Type()) {
		return fmt.Sprintf("column %q is a %s field, which a %s field cannot read", f.Column, pf.Type(), f.Type)
	}
	switch x := pf.(type) {
	case *core.SelectField:
		if x.IsMultiple() {
			return fmt.Sprintf("column %q holds many values", f.Column)
		}
		for _, o := range f.Options {
			if !slices.Contains(x.Values, o.Value) {
				return fmt.Sprintf("option %q is not a value of column %q", o.Value, f.Column)
			}
		}
	case *core.RelationField:
		if x.IsMultiple() {
			return fmt.Sprintf("column %q holds many values", f.Column)
		}
	}
	return ""
}

var compatible = map[FieldType][]string{
	Text:     {core.FieldTypeText, core.FieldTypeEmail, core.FieldTypeURL, core.FieldTypeEditor},
	Number:   {core.FieldTypeNumber},
	Money:    {core.FieldTypeNumber},
	Date:     {core.FieldTypeDate, core.FieldTypeAutodate},
	DateTime: {core.FieldTypeDate, core.FieldTypeAutodate},
	Bool:     {core.FieldTypeBool},
	Select:   {core.FieldTypeSelect},
	Relation: {core.FieldTypeRelation},
}

func checkLink(app core.App, src *Source, col *core.Collection, l Link) string {
	target := sources[l.Target]
	if target == nil {
		return fmt.Sprintf("target source %q is not registered", l.Target)
	}
	targetCol, err := app.FindCollectionByNameOrId(target.Collection)
	if err != nil {
		return fmt.Sprintf("target collection %q does not exist", target.Collection)
	}
	owner, column, pointsAt := col, l.Field, targetCol
	if l.Cardinality == ToMany {
		owner, column, pointsAt = targetCol, l.BackField, col
	}
	rel, ok := owner.Fields.GetByName(column).(*core.RelationField)
	if !ok {
		return fmt.Sprintf("%q is not a relation field of %q", column, owner.Name)
	}
	if rel.IsMultiple() {
		return fmt.Sprintf("relation %q of %q holds many values", column, owner.Name)
	}
	if rel.GetHidden() {
		return fmt.Sprintf("relation %q of %q is hidden from the API", column, owner.Name)
	}
	if rel.CollectionId != pointsAt.Id {
		return fmt.Sprintf("relation %q of %q does not point at %q", column, owner.Name, pointsAt.Name)
	}
	return ""
}

// checkRule builds the list rule for a reader who exists only for the check,
// then has SQLite compile the result.
func checkRule(app core.App, col *core.Collection) string {
	users, err := app.FindCachedCollectionByNameOrId("users")
	if err != nil {
		return "no users collection to check the list rule with"
	}
	reader := core.NewRecord(users)
	reader.Id = "reportcheck0000"
	sql, params, err := ruleSelect(app, col, listRequestInfo(reader, nil))
	if err != nil {
		return err.Error()
	}
	if _, err := app.DB().NewQuery("EXPLAIN " + sql).Bind(params).Execute(); err != nil {
		return fmt.Sprintf("the list rule of %q does not compile: %v", col.Name, err)
	}
	return ""
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/rules.go \
  core/server/reports/check.go \
  core/server/reports/zoo_test.go \
  core/server/reports/rules_test.go \
  core/server/reports/check_test.go
git commit -m "feat(core): report rule CTEs from the list rule resolver; CheckSources"
```

---

### Task 5: The report spec: types, `Load`, version upgrades and aliases

**Files:**
- Create: `$WS/tinycld/core/server/reports/spec.go`
- Test: `$WS/tinycld/core/server/reports/spec_test.go`

**Interfaces:**
- Consumes: `lookupSource`, `(*Source).field/link`, `registerZooSources` (Tasks 3–4).
- Produces:
  - JSON types `Spec{Version, Source, Params, Columns, Filter, Sort, Groups, Pivot, Layout}`, `Hop{Link, Field, Mode, With}`, `Path []Hop`, `Column{ID, Label, Path, Formula, Aggregate, Scale *int, Format}`, `Node{Op, Args, Scale *int, Col, Path, Param, Value json.RawMessage, Subtotal, Link Path, Where}`, `SortKey{Col, Dir}`, `Group{ID, Col, Bucket, Subtotals}`, `Pivot{Path, Bucket, Cell, MaxColumns}`, `LayoutItem{Section, Title, Key json.RawMessage, Row, Label, Formula}`, `ParamDef{ID, Type, Label, Default, Options, Multiple}`.
  - `const CurrentVersion = 1`; `var upgradeSteps map[int]upgradeStep`; `func upgrade(raw []byte, steps map[int]upgradeStep, target int) ([]byte, int, error)`.
  - `func Load(raw []byte) (*Spec, *LoadInfo, error)`; `LoadInfo{UpgradedFrom int; Aliased []Alias}`; `Alias{Source, From, To}`.
  - `type SpecError struct{ Status int; Problems map[string]validation.Error }` (400 invalid, 422 unknown reference); `func invalid(at, message string) *SpecError`.
  - Test helpers in `spec_test.go`: `withZooRegistry(t)`, `requireSpecError(t, err, status, at, contains)`, `const designExample` (the spec's example, on zoo sources). Later tasks use all three.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/spec_test.go`:

```go
package reports

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func withZooRegistry(t *testing.T) {
	t.Helper()
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	registerZooSources()
}

func requireSpecError(t *testing.T, err error, status int, at, contains string) {
	t.Helper()
	var se *SpecError
	if !errors.As(err, &se) {
		t.Fatalf("err = %v, want a *SpecError", err)
	}
	if se.Status != status {
		t.Fatalf("status = %d, want %d (%v)", se.Status, status, se)
	}
	problem, ok := se.Problems[at]
	if !ok {
		t.Fatalf("no problem at %q: %v", at, se)
	}
	if !strings.Contains(problem.Error(), contains) {
		t.Fatalf("problem at %q = %q, want it to contain %q", at, problem.Error(), contains)
	}
}

const designExample = `{
  "version": 1,
  "source": "zoo.feedings",
  "params": [ { "id": "period", "type": "dateRange", "default": { "preset": "thisFiscalYear" } } ],
  "columns": [
    { "id": "site", "path": [{ "link": "animal" }, { "link": "site" }, { "field": "name" }], "label": "Site" },
    { "id": "total", "path": [{ "field": "cost" }], "aggregate": "sum" },
    { "id": "keepers", "path": [{ "link": "animal" }, { "link": "keepers", "mode": "aggregate" }, { "field": "id" }], "aggregate": "count" },
    { "id": "grams", "path": [{ "field": "grams" }], "aggregate": "sum" },
    { "id": "perGram", "formula": { "op": "div", "args": [ { "col": "total" }, { "col": "grams" } ], "scale": 0 } }
  ],
  "filter": { "op": "and", "args": [
    { "op": "between", "args": [ { "path": [{ "field": "fed" }] }, { "param": "period" } ] },
    { "op": "exists", "link": [{ "link": "animal" }, { "link": "keepers" }],
      "where": { "op": "eq", "args": [ { "path": [{ "link": "user" }, { "field": "name" }] }, { "value": "ann" } ] } }
  ] },
  "sort": [ { "col": "total", "dir": "desc" } ],
  "groups": [ { "id": "bySite", "col": "site", "subtotals": true } ],
  "pivot": { "path": [{ "field": "fed" }], "bucket": "month", "cell": "total", "maxColumns": 50 },
  "layout": null
}`

func TestLoadReadsTheDesignExample(t *testing.T) {
	withZooRegistry(t)
	spec, info, err := Load([]byte(designExample))
	if err != nil {
		t.Fatal(err)
	}
	if spec.Source != "zoo.feedings" || len(spec.Columns) != 5 || spec.Pivot.Cell != "total" {
		t.Fatalf("spec = %+v", spec)
	}
	if string(spec.Filter.Args[1].Where.Args[1].Value) != `"ann"` {
		t.Fatalf("value = %s", spec.Filter.Args[1].Where.Args[1].Value)
	}
	if info.UpgradedFrom != 0 || len(info.Aliased) != 0 {
		t.Fatalf("info = %+v", info)
	}
}

func TestLoadRefusesWhatIsNotASpec(t *testing.T) {
	withZooRegistry(t)
	cases := map[string]struct {
		raw, at, want string
	}{
		"not json":        {`[1]`, "spec", "not a single JSON object"},
		"unknown key":     {`{"version":1,"source":"zoo.feedings","columns":[],"sql":"DROP"}`, "spec", "unknown field"},
		"trailing data":   {`{"version":1,"source":"zoo.feedings","columns":[]} {}`, "spec", "not a single JSON object"},
		"no version":      {`{"source":"zoo.feedings","columns":[]}`, "version", "whole number"},
		"version zero":    {`{"version":0,"columns":[]}`, "version", "whole number"},
		"version 1.5":     {`{"version":1.5,"columns":[]}`, "version", "whole number"},
		"newer version":   {`{"version":2,"columns":[]}`, "version", "newer than this server reads (1)"},
		"wrong leaf type": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":"cost"}]}`, "spec", "cannot unmarshal"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, err := Load([]byte(c.raw))
			requireSpecError(t, err, 400, c.at, c.want)
		})
	}
}

func TestUpgradeRunsEveryStepInOrder(t *testing.T) {
	steps := map[int]upgradeStep{
		1: func(doc map[string]any) error {
			doc["columns"] = doc["cols"]
			delete(doc, "cols")
			return nil
		},
		2: func(doc map[string]any) error {
			doc["source"] = "zoo." + doc["source"].(string)
			return nil
		},
	}
	out, from, err := upgrade([]byte(`{"version":1,"source":"feedings","cols":[]}`), steps, 3)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"version": float64(3), "source": "zoo.feedings", "columns": []any{}}
	if from != 1 || !reflect.DeepEqual(doc, want) {
		t.Fatalf("from %d, doc %v", from, doc)
	}
	if _, _, err := upgrade([]byte(`{"version":1}`), map[int]upgradeStep{}, 2); err == nil {
		t.Fatal("a missing step must fail")
	}
}

func TestLoadResolvesAliasesOnEveryPath(t *testing.T) {
	withZooRegistry(t)
	raw := `{"version":1,"source":"zoo.feedings",
		"columns":[{"id":"w","path":[{"link":"animal"},{"field":"mass"}],"aggregate":"sum"},
		           {"id":"f","formula":{"op":"mul","args":[{"path":[{"link":"animal"},{"field":"mass"}]},{"value":2}]}}],
		"filter":{"op":"exists","link":[{"link":"animal"},{"link":"site"},{"link":"animals"}],
		          "where":{"op":"gt","args":[{"path":[{"field":"mass"}]},{"value":10}]}}}`
	spec, info, err := Load([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if spec.Columns[0].Path[1].Field != "weight" || spec.Columns[1].Formula.Args[0].Path[1].Field != "weight" {
		t.Fatalf("columns not resolved: %+v", spec.Columns)
	}
	if spec.Filter.Where.Args[0].Path[0].Field != "weight" {
		t.Fatalf("exists where not resolved: %+v", spec.Filter.Where.Args[0].Path)
	}
	want := Alias{Source: "zoo.animals", From: "mass", To: "weight"}
	if len(info.Aliased) != 3 || info.Aliased[0] != want {
		t.Fatalf("aliased = %+v", info.Aliased)
	}
}

func TestSpecErrorNamesEveryProblem(t *testing.T) {
	err := invalid("columns.0.id", "an id is required")
	if !strings.Contains(err.Error(), "columns.0.id: an id is required") {
		t.Fatalf("Error() = %q", err.Error())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: SpecError`, `undefined: Load`, …

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/spec.go`:

```go
package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

// CurrentVersion is the spec version this engine writes. Load upgrades an
// older spec one version at a time with upgradeSteps.
const CurrentVersion = 1

// upgradeSteps[v] turns a version v document into version v+1 and sets its
// version. Add a step whenever the spec format changes, and raise
// CurrentVersion with it.
var upgradeSteps = map[int]upgradeStep{}

type upgradeStep func(doc map[string]any) error

// Spec is a report: versioned JSON, never SQL.
type Spec struct {
	Version int          `json:"version"`
	Source  string       `json:"source"`
	Params  []ParamDef   `json:"params,omitempty"`
	Columns []Column     `json:"columns"`
	Filter  *Node        `json:"filter,omitempty"`
	Sort    []SortKey    `json:"sort,omitempty"`
	Groups  []Group      `json:"groups,omitempty"`
	Pivot   *Pivot       `json:"pivot,omitempty"`
	Layout  []LayoutItem `json:"layout,omitempty"`
}

// Hop is one step of a path: a link to follow, or the field to read last.
type Hop struct {
	Link  string `json:"link,omitempty"`
	Field string `json:"field,omitempty"`
	// Mode, on a to-many hop: "aggregate" (a total per row) or "nest"
	// (child rows).
	Mode string `json:"mode,omitempty"`
	// With is "required" (inner join) or "optional" (left join, the default).
	With string `json:"with,omitempty"`
}

// Path is links then, for a value, one final field hop.
type Path []Hop

// Column is a path to a field, or a formula over other columns.
type Column struct {
	ID        string    `json:"id"`
	Label     string    `json:"label,omitempty"`
	Path      Path      `json:"path,omitempty"`
	Formula   *Node     `json:"formula,omitempty"`
	Aggregate Aggregate `json:"aggregate,omitempty"`
	// Scale is the decimal places of an avg aggregate.
	Scale *int `json:"scale,omitempty"`
	// Format is the client's display format, returned as given.
	Format string `json:"format,omitempty"`
}

// Node is a formula or filter tree: an operator with arguments, or a leaf
// (col, path, param, value, subtotal). exists and notExists carry a link path
// and an optional where.
type Node struct {
	Op       string          `json:"op,omitempty"`
	Args     []*Node         `json:"args,omitempty"`
	Scale    *int            `json:"scale,omitempty"`
	Col      string          `json:"col,omitempty"`
	Path     Path            `json:"path,omitempty"`
	Param    string          `json:"param,omitempty"`
	Value    json.RawMessage `json:"value,omitempty"`
	Subtotal string          `json:"subtotal,omitempty"`
	Link     Path            `json:"link,omitempty"`
	Where    *Node           `json:"where,omitempty"`
}

type SortKey struct {
	Col string `json:"col"`
	Dir string `json:"dir,omitempty"` // "asc" (default) or "desc"
}

type Group struct {
	ID        string `json:"id"`
	Col       string `json:"col"`
	Bucket    string `json:"bucket,omitempty"` // a date column's bucket
	Subtotals bool   `json:"subtotals,omitempty"`
}

type Pivot struct {
	Path       Path   `json:"path"`
	Bucket     string `json:"bucket,omitempty"`
	Cell       string `json:"cell"`
	MaxColumns int    `json:"maxColumns,omitempty"`
}

// LayoutItem is a section (section, title, key: the first group's key it
// shows) or a computed row (row, label, formula over {subtotal} leaves).
type LayoutItem struct {
	Section string          `json:"section,omitempty"`
	Title   string          `json:"title,omitempty"`
	Key     json.RawMessage `json:"key,omitempty"`
	Row     string          `json:"row,omitempty"`
	Label   string          `json:"label,omitempty"`
	Formula *Node           `json:"formula,omitempty"`
}

type ParamDef struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Label    string          `json:"label,omitempty"`
	Default  json.RawMessage `json:"default,omitempty"`
	Options  []Option        `json:"options,omitempty"`
	Multiple bool            `json:"multiple,omitempty"`
}

// LoadInfo says what Load changed: the version it upgraded from (0 when it
// did not upgrade) and every alias it resolved.
type LoadInfo struct {
	UpgradedFrom int
	Aliased      []Alias
}

// Alias is one old key Load replaced with its new key.
type Alias struct {
	Source string `json:"source"`
	From   string `json:"from"`
	To     string `json:"to"`
}

// SpecError lists what is wrong with a spec, keyed by the dotted path of the
// part (`columns.2.path.1.link`). Status is 400 for an invalid spec and 422
// when it names a source, link, field or column that does not exist.
type SpecError struct {
	Status   int
	Problems map[string]validation.Error
}

func (e *SpecError) Error() string {
	keys := make([]string, 0, len(e.Problems))
	for k := range e.Problems {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+": "+e.Problems[k].Error())
	}
	return "reports: " + strings.Join(parts, "; ")
}

func invalid(at, message string) *SpecError {
	return &SpecError{Status: 400, Problems: map[string]validation.Error{at: validation.NewError("invalid", message)}}
}

// Load reads a stored or posted spec: it upgrades an older version to
// CurrentVersion, decodes it strictly (an unknown key is an error), and
// replaces every aliased key with its current key. Validate checks the
// result. A spec saved again is saved as Load returns it.
func Load(raw []byte) (*Spec, *LoadInfo, error) {
	upgraded, from, err := upgrade(raw, upgradeSteps, CurrentVersion)
	if err != nil {
		return nil, nil, err
	}
	var spec Spec
	dec := json.NewDecoder(bytes.NewReader(upgraded))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&spec); err != nil {
		return nil, nil, invalid("spec", "the spec is not valid: "+err.Error())
	}
	info := &LoadInfo{Aliased: resolveAliases(&spec)}
	if from != CurrentVersion {
		info.UpgradedFrom = from
	}
	return &spec, info, nil
}

// upgrade runs steps from the document's version up to target.
func upgrade(raw []byte, steps map[int]upgradeStep, target int) ([]byte, int, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, 0, invalid("spec", "the spec is not a single JSON object")
	}
	v, ok := doc["version"].(float64)
	if !ok || v != float64(int(v)) || v < 1 {
		return nil, 0, invalid("version", "version must be a whole number from 1")
	}
	from := int(v)
	if from > target {
		return nil, 0, invalid("version", fmt.Sprintf("version %d is newer than this server reads (%d)", from, target))
	}
	if from == target {
		return raw, from, nil
	}
	for at := from; at < target; at++ {
		step := steps[at]
		if step == nil {
			return nil, 0, fmt.Errorf("reports: no upgrade from spec version %d", at)
		}
		if err := step(doc); err != nil {
			return nil, 0, invalid("version", fmt.Sprintf("version %d cannot be upgraded: %v", at, err))
		}
		doc["version"] = at + 1
	}
	out, err := json.Marshal(doc)
	return out, from, err
}

// resolveAliases replaces an aliased link or field key on every path with
// its current key. A key it cannot place (an unknown source, a link that
// does not exist) is left for Validate to report.
func resolveAliases(spec *Spec) []Alias {
	base := lookupSource(spec.Source)
	if base == nil {
		return nil
	}
	var out []Alias
	for i := range spec.Columns {
		aliasPath(base, spec.Columns[i].Path, &out)
		aliasNode(base, spec.Columns[i].Formula, &out)
	}
	aliasNode(base, spec.Filter, &out)
	if spec.Pivot != nil {
		aliasPath(base, spec.Pivot.Path, &out)
	}
	return out
}

// aliasPath resolves a path's keys in place and returns the source the path
// ends on, or nil when a hop cannot be followed.
func aliasPath(src *Source, path Path, out *[]Alias) *Source {
	for i := range path {
		if src == nil {
			return nil
		}
		hop := &path[i]
		if hop.Link != "" {
			hop.Link = aliasKey(src, hop.Link, out)
			l := src.link(hop.Link)
			if l == nil {
				return nil
			}
			src = lookupSource(l.Target)
		}
		if hop.Field != "" {
			hop.Field = aliasKey(src, hop.Field, out)
		}
	}
	return src
}

func aliasKey(src *Source, key string, out *[]Alias) string {
	if src.field(key) != nil || src.link(key) != nil {
		return key
	}
	to, ok := src.Aliases[key]
	if !ok {
		return key
	}
	*out = append(*out, Alias{Source: src.Key, From: key, To: to})
	return to
}

func aliasNode(src *Source, n *Node, out *[]Alias) {
	if n == nil {
		return
	}
	aliasPath(src, n.Path, out)
	for _, a := range n.Args {
		aliasNode(src, a, out)
	}
	if n.Link != nil {
		// A where clause reads the source the link path ends on.
		aliasNode(aliasPath(src, n.Link, out), n.Where, out)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/spec.go \
  core/server/reports/spec_test.go
git commit -m "feat(core): report spec, Load with version upgrades and field aliases"
```

---

### Task 6: The formula compiler and the shared formula table

**Files:**
- Create: `$WS/tinycld/core/server/reports/formula.go`
- Create: `$WS/tinycld/core/lib/forms/fixtures/formula-cases.json` (the shared table)
- Test: `$WS/tinycld/core/server/reports/formula_test.go`, `$WS/tinycld/core/server/reports/formula_cases_test.go`
- Test: `$WS/tinycld/core/server/forms/formula_cases_test.go` (forms engine, Go)
- Test: `$WS/tinycld/core/lib/forms/__tests__/formula-cases.test.ts` (forms engine, TS)

There is a Go forms evaluator: `core/server/forms/compute.go` (`evalCompute`, `parseExpr`) mirrors `core/lib/forms/expression.ts` (`evalCompute`, `computeExprSchema`), and `core/lib/forms/fixtures/computed-fixture.json` already pins both. The forms formula is a different JSON shape (`{"add": [{"var": "a"}, 2]}`) with fewer operators (number, `var`, `add`, `sub`, `mul`, `div`, `round`, `min`, `max`, `sumOf`, `count`). So each case of the shared table has the report formula in `formula`, and a case the forms engine can express also has the same calculation in `forms`. The report compiler runs every case; both forms engines run every case that has `forms`; a shared case's `expect` holds for all three. The report harness compiles the formula with the real compiler over a one-table query (`WITH t(cols) AS (VALUES …)`), so every case runs through SQLite and the registered Go functions.

**Interfaces:**
- Consumes: `Node`, `Path`, `invalid` (Task 5); registry types (Task 3); `MaxScale`, the SQLite functions and `newPlainApp` (Task 1).
- Produces:
  - `type expr struct{ sql string; typ FieldType; rng bool; lo, hi string; list, lit, unset, agg, win bool }`.
  - `type fctx interface { col(id, at string) (expr, error); path(p Path, at string) (expr, error); param(id, at string) (expr, error); subtotal(id, at string) (expr, error); aggregate(op Aggregate, arg *Node, scale int, at string) (expr, error); window(op string, arg *Node, scale int, at string) (expr, error); exists(n *Node, at string) (expr, error); bind(v any) string; fiscalStart() string; filter() bool }` — `aggregate` and `window` get the operator node's path; the value is at `path + ".args.0"`.
  - `func compileFormula(c fctx, n *Node, at string) (expr, error)`; `func aggregateSQL(op Aggregate, arg string, scale int) string`; `func aggregateType(op Aggregate, t FieldType, scale int) FieldType`; `func checkAggregate(op Aggregate, t FieldType, scale int, at string) error`; `func numberValue(n json.Number) any`; `func isNumeric(t FieldType) bool`; `func isDateLike(t FieldType) bool`; `func num(e expr) string`; `func sumType(args []expr) FieldType`.

- [ ] **Step 1: Write the shared table**

`$WS/tinycld/core/lib/forms/fixtures/formula-cases.json` (65 cases; the first 22 carry `forms`):

```json
{
    "cases": [
        {
            "name": "add two numbers",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 2, "b": 3 },
            "formula": { "op": "add", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "add": [{ "var": "a" }, { "var": "b" }] },
            "expect": 5
        },
        {
            "name": "add three numbers",
            "types": { "a": "number", "b": "number", "c": "number" },
            "values": { "a": 1, "b": 2, "c": 3.5 },
            "formula": { "op": "add", "args": [{ "col": "a" }, { "col": "b" }, { "col": "c" }] },
            "forms": { "add": [{ "var": "a" }, { "var": "b" }, { "var": "c" }] },
            "expect": 6.5
        },
        {
            "name": "add counts a blank as zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 2, "b": null },
            "formula": { "op": "add", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "add": [{ "var": "a" }, { "var": "b" }] },
            "expect": 2
        },
        {
            "name": "sub",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 10, "b": 4 },
            "formula": { "op": "sub", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "sub": [{ "var": "a" }, { "var": "b" }] },
            "expect": 6
        },
        {
            "name": "sub below zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 4, "b": 10 },
            "formula": { "op": "sub", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "sub": [{ "var": "a" }, { "var": "b" }] },
            "expect": -6
        },
        {
            "name": "mul",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 3, "b": 4.5 },
            "formula": { "op": "mul", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "mul": [{ "var": "a" }, { "var": "b" }] },
            "expect": 13.5
        },
        {
            "name": "mul counts a blank as zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 3, "b": null },
            "formula": { "op": "mul", "args": [{ "col": "a" }, { "col": "b" }] },
            "forms": { "mul": [{ "var": "a" }, { "var": "b" }] },
            "expect": 0
        },
        {
            "name": "div rounds at scale 2",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 1, "b": 3 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 2 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 2] },
            "expect": 0.33
        },
        {
            "name": "div rounds half away from zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 5, "b": 2 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 0 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 0] },
            "expect": 3
        },
        {
            "name": "div rounds a negative half away from zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": -5, "b": 2 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 0 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 0] },
            "expect": -3
        },
        {
            "name": "div by zero is zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 7, "b": 0 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 2 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 2] },
            "expect": 0
        },
        {
            "name": "div by a blank is zero",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 7, "b": null },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 2 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 2] },
            "expect": 0
        },
        {
            "name": "div of a fraction",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 7.5, "b": 2 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 1 },
            "forms": { "round": [{ "div": [{ "var": "a" }, { "var": "b" }] }, 1] },
            "expect": 3.8
        },
        {
            "name": "round",
            "types": { "a": "number" },
            "values": { "a": 2.345 },
            "formula": { "op": "round", "args": [{ "col": "a" }], "scale": 2 },
            "forms": { "round": [{ "var": "a" }, 2] },
            "expect": 2.35
        },
        {
            "name": "round a negative half away from zero",
            "types": { "a": "number" },
            "values": { "a": -2.5 },
            "formula": { "op": "round", "args": [{ "col": "a" }], "scale": 0 },
            "forms": { "round": [{ "var": "a" }, 0] },
            "expect": -3
        },
        {
            "name": "min of values",
            "types": { "a": "number", "b": "number", "c": "number" },
            "values": { "a": 3, "b": 1.5, "c": 2 },
            "formula": { "op": "min", "args": [{ "col": "a" }, { "col": "b" }, { "col": "c" }] },
            "forms": { "min": [{ "var": "a" }, { "var": "b" }, { "var": "c" }] },
            "expect": 1.5
        },
        {
            "name": "max of values",
            "types": { "a": "number", "b": "number", "c": "number" },
            "values": { "a": 3, "b": 1.5, "c": 2 },
            "formula": { "op": "max", "args": [{ "col": "a" }, { "col": "b" }, { "col": "c" }] },
            "forms": { "max": [{ "var": "a" }, { "var": "b" }, { "var": "c" }] },
            "expect": 3
        },
        {
            "name": "max with a literal",
            "types": { "a": "number" },
            "values": { "a": -4 },
            "formula": { "op": "max", "args": [{ "col": "a" }, { "value": 0 }] },
            "forms": { "max": [{ "var": "a" }, 0] },
            "expect": 0
        },
        {
            "name": "sum of rows",
            "types": { "amount": "number" },
            "rows": [{ "amount": 2 }, { "amount": 3 }, { "amount": 4.5 }],
            "formula": { "op": "sum", "args": [{ "col": "amount" }] },
            "forms": { "sumOf": [{ "var": "rows" }, "amount"] },
            "expect": 9.5
        },
        {
            "name": "sum of no rows is zero",
            "types": { "amount": "number" },
            "rows": [],
            "formula": { "op": "sum", "args": [{ "col": "amount" }] },
            "forms": { "sumOf": [{ "var": "rows" }, "amount"] },
            "expect": 0
        },
        {
            "name": "count of rows",
            "types": { "amount": "number" },
            "rows": [{ "amount": 2 }, { "amount": 3 }, { "amount": 0 }],
            "formula": { "op": "count", "args": [{ "col": "amount" }] },
            "forms": { "count": [{ "var": "rows" }] },
            "expect": 3
        },
        {
            "name": "arithmetic over a sum",
            "types": { "amount": "number" },
            "rows": [{ "amount": 100 }, { "amount": 200 }],
            "formula": {
                "op": "div",
                "args": [
                    {
                        "op": "mul",
                        "args": [{ "op": "sum", "args": [{ "col": "amount" }] }, { "value": 7 }]
                    },
                    { "value": 100 }
                ],
                "scale": 0
            },
            "forms": {
                "round": [
                    { "div": [{ "mul": [{ "sumOf": [{ "var": "rows" }, "amount"] }, 7] }, 100] },
                    0
                ]
            },
            "expect": 21
        },
        {
            "name": "div of integers stays exact near 2^53",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 9007199254740991, "b": 2 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 0 },
            "expect": 4503599627370496
        },
        {
            "name": "an amount times a number rounds to whole cents",
            "types": { "a": "money", "b": "number" },
            "values": { "a": 1000, "b": 0.075 },
            "formula": { "op": "mul", "args": [{ "col": "a" }, { "col": "b" }] },
            "expect": 75
        },
        {
            "name": "an amount divided by a number keeps whole cents",
            "types": { "a": "money", "b": "number" },
            "values": { "a": 1000, "b": 3 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "b" }], "scale": 0 },
            "expect": 333
        },
        {
            "name": "a ratio of amounts",
            "types": { "a": "money", "c": "money" },
            "values": { "a": 1234, "c": 5000 },
            "formula": { "op": "div", "args": [{ "col": "a" }, { "col": "c" }], "scale": 4 },
            "expect": 0.2468
        },
        {
            "name": "eq of two blanks is true",
            "types": { "a": "text" },
            "values": { "a": null },
            "formula": { "op": "eq", "args": [{ "col": "a" }, { "value": null }] },
            "expect": true
        },
        {
            "name": "eq of text",
            "types": { "a": "text" },
            "values": { "a": "hay" },
            "formula": { "op": "eq", "args": [{ "col": "a" }, { "value": "hay" }] },
            "expect": true
        },
        {
            "name": "ne of a value and a blank is true",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 1, "b": null },
            "formula": { "op": "ne", "args": [{ "col": "a" }, { "col": "b" }] },
            "expect": true
        },
        {
            "name": "lt",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 1, "b": 2 },
            "formula": { "op": "lt", "args": [{ "col": "a" }, { "col": "b" }] },
            "expect": true
        },
        {
            "name": "gte of dates",
            "types": { "a": "date" },
            "values": { "a": "2026-01-01" },
            "formula": { "op": "gte", "args": [{ "col": "a" }, { "value": "2026-01-01" }] },
            "expect": true
        },
        {
            "name": "between three values",
            "types": { "a": "number" },
            "values": { "a": 4 },
            "formula": {
                "op": "between",
                "args": [{ "col": "a" }, { "value": 1 }, { "value": 3 }]
            },
            "expect": false
        },
        {
            "name": "in a list",
            "types": { "a": "text" },
            "values": { "a": "fish" },
            "formula": { "op": "in", "args": [{ "col": "a" }, { "value": ["hay", "fish"] }] },
            "expect": true
        },
        {
            "name": "in an empty list",
            "types": { "a": "text" },
            "values": { "a": "fish" },
            "formula": { "op": "in", "args": [{ "col": "a" }, { "value": [] }] },
            "expect": false
        },
        {
            "name": "and",
            "types": { "a": "number" },
            "values": { "a": 3 },
            "formula": {
                "op": "and",
                "args": [
                    { "op": "gt", "args": [{ "col": "a" }, { "value": 1 }] },
                    { "op": "lt", "args": [{ "col": "a" }, { "value": 5 }] }
                ]
            },
            "expect": true
        },
        {
            "name": "or",
            "types": { "a": "number" },
            "values": { "a": 3 },
            "formula": {
                "op": "or",
                "args": [
                    { "op": "gt", "args": [{ "col": "a" }, { "value": 5 }] },
                    { "op": "lt", "args": [{ "col": "a" }, { "value": 2 }] }
                ]
            },
            "expect": false
        },
        {
            "name": "not of a condition on a blank is true",
            "types": { "a": "number" },
            "values": { "a": null },
            "formula": {
                "op": "not",
                "args": [{ "op": "gt", "args": [{ "col": "a" }, { "value": 1 }] }]
            },
            "expect": true
        },
        {
            "name": "concat skips blanks",
            "types": { "a": "text", "b": "text" },
            "values": { "a": "hay", "b": null },
            "formula": {
                "op": "concat",
                "args": [{ "col": "a" }, { "value": "-" }, { "col": "b" }]
            },
            "expect": "hay-"
        },
        {
            "name": "upper",
            "types": { "a": "text" },
            "values": { "a": "hay" },
            "formula": { "op": "upper", "args": [{ "col": "a" }] },
            "expect": "HAY"
        },
        {
            "name": "lower",
            "types": { "a": "text" },
            "values": { "a": "HaY" },
            "formula": { "op": "lower", "args": [{ "col": "a" }] },
            "expect": "hay"
        },
        {
            "name": "contains ignores case",
            "types": { "a": "text" },
            "values": { "a": "fresh grass" },
            "formula": { "op": "contains", "args": [{ "col": "a" }, { "value": "RAS" }] },
            "expect": true
        },
        {
            "name": "startsWith ignores case",
            "types": { "a": "text" },
            "values": { "a": "fresh grass" },
            "formula": { "op": "startsWith", "args": [{ "col": "a" }, { "value": "FRE" }] },
            "expect": true
        },
        {
            "name": "startsWith of a longer prefix",
            "types": { "a": "text" },
            "values": { "a": "fresh grass" },
            "formula": {
                "op": "startsWith",
                "args": [{ "col": "a" }, { "value": "fresh grass!" }]
            },
            "expect": false
        },
        {
            "name": "year",
            "types": { "a": "datetime" },
            "values": { "a": "2026-08-15 10:00:00.000Z" },
            "formula": { "op": "year", "args": [{ "col": "a" }] },
            "expect": 2026
        },
        {
            "name": "quarter",
            "types": { "a": "date" },
            "values": { "a": "2026-08-15" },
            "formula": { "op": "quarter", "args": [{ "col": "a" }] },
            "expect": 3
        },
        {
            "name": "month",
            "types": { "a": "date" },
            "values": { "a": "2026-08-15" },
            "formula": { "op": "month", "args": [{ "col": "a" }] },
            "expect": 8
        },
        {
            "name": "fiscal year with a July start",
            "types": { "a": "date" },
            "values": { "a": "2026-08-15" },
            "fiscalStart": 7,
            "formula": { "op": "fiscalYear", "args": [{ "col": "a" }] },
            "expect": 2027
        },
        {
            "name": "fiscal period with a July start",
            "types": { "a": "date" },
            "values": { "a": "2026-08-15" },
            "fiscalStart": 7,
            "formula": { "op": "fiscalPeriod", "args": [{ "col": "a" }] },
            "expect": 2
        },
        {
            "name": "addDays crosses a month",
            "types": { "a": "date" },
            "values": { "a": "2026-02-27" },
            "formula": { "op": "addDays", "args": [{ "col": "a" }, { "value": 2 }] },
            "expect": "2026-03-01"
        },
        {
            "name": "addMonths holds the month end",
            "types": { "a": "date" },
            "values": { "a": "2026-01-31" },
            "formula": { "op": "addMonths", "args": [{ "col": "a" }, { "value": 1 }] },
            "expect": "2026-02-28"
        },
        {
            "name": "diffDays",
            "types": { "a": "date", "b": "date" },
            "values": { "a": "2026-01-01", "b": "2026-03-01" },
            "formula": { "op": "diffDays", "args": [{ "col": "a" }, { "col": "b" }] },
            "expect": 59
        },
        {
            "name": "if",
            "types": { "a": "number", "b": "number" },
            "values": { "a": 1, "b": 2 },
            "formula": {
                "op": "if",
                "args": [
                    { "op": "gt", "args": [{ "col": "a" }, { "col": "b" }] },
                    { "value": "more" },
                    { "value": "less" }
                ]
            },
            "expect": "less"
        },
        {
            "name": "case falls through to else",
            "types": { "a": "number" },
            "values": { "a": 3 },
            "formula": {
                "op": "case",
                "args": [
                    { "op": "gt", "args": [{ "col": "a" }, { "value": 10 }] },
                    { "value": "big" },
                    { "op": "gt", "args": [{ "col": "a" }, { "value": 5 }] },
                    { "value": "mid" },
                    { "value": "small" }
                ]
            },
            "expect": "small"
        },
        {
            "name": "coalesce",
            "types": { "a": "number" },
            "values": { "a": null },
            "formula": { "op": "coalesce", "args": [{ "col": "a" }, { "value": 5 }] },
            "expect": 5
        },
        {
            "name": "isEmpty of empty text",
            "types": { "a": "text" },
            "values": { "a": "" },
            "formula": { "op": "isEmpty", "args": [{ "col": "a" }] },
            "expect": true
        },
        {
            "name": "isEmpty of a blank",
            "types": { "a": "text" },
            "values": { "a": null },
            "formula": { "op": "isEmpty", "args": [{ "col": "a" }] },
            "expect": true
        },
        {
            "name": "isEmpty of text",
            "types": { "a": "text" },
            "values": { "a": "x" },
            "formula": { "op": "isEmpty", "args": [{ "col": "a" }] },
            "expect": false
        },
        {
            "name": "countDistinct",
            "types": { "a": "text" },
            "rows": [{ "a": "x" }, { "a": "x" }, { "a": "y" }],
            "formula": { "op": "countDistinct", "args": [{ "col": "a" }] },
            "expect": 2
        },
        {
            "name": "count skips blanks",
            "types": { "a": "text" },
            "rows": [{ "a": "x" }, { "a": null }],
            "formula": { "op": "count", "args": [{ "col": "a" }] },
            "expect": 1
        },
        {
            "name": "min of text",
            "types": { "a": "text" },
            "rows": [{ "a": "cat" }, { "a": "ape" }],
            "formula": { "op": "min", "args": [{ "col": "a" }] },
            "expect": "ape"
        },
        {
            "name": "max of dates",
            "types": { "a": "date" },
            "rows": [{ "a": "2026-03-01" }, { "a": "2026-01-01" }],
            "formula": { "op": "max", "args": [{ "col": "a" }] },
            "expect": "2026-03-01"
        },
        {
            "name": "avg of amounts rounds to whole cents",
            "types": { "a": "money" },
            "rows": [{ "a": 100 }, { "a": 101 }],
            "formula": { "op": "avg", "args": [{ "col": "a" }], "scale": 0 },
            "expect": 101
        },
        {
            "name": "avg of numbers",
            "types": { "a": "number" },
            "rows": [{ "a": 1 }, { "a": 2 }, { "a": 2 }],
            "formula": { "op": "avg", "args": [{ "col": "a" }], "scale": 2 },
            "expect": 1.67
        },
        {
            "name": "avg of no rows is blank",
            "types": { "a": "number" },
            "rows": [],
            "formula": { "op": "avg", "args": [{ "col": "a" }], "scale": 2 },
            "expect": null
        },
        {
            "name": "sum of amounts too large",
            "types": { "a": "money" },
            "rows": [{ "a": 9223372036854775807 }, { "a": 1 }],
            "formula": { "op": "sum", "args": [{ "col": "a" }] },
            "error": "integer overflow"
        }
    ]
}
```

- [ ] **Step 2: Write the failing tests**

`$WS/tinycld/core/server/reports/formula_cases_test.go`:

```go
package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// The table the forms engine (TS and Go) runs too; see
// core/lib/forms/__tests__/formula-cases.test.ts and
// core/server/forms/formula_cases_test.go. A case with a "forms" formula is
// shared: both engines must give its expected value.
const formulaCasesPath = "../../lib/forms/fixtures/formula-cases.json"

type formulaCase struct {
	Name        string               `json:"name"`
	Types       map[string]FieldType `json:"types"`
	Values      map[string]any       `json:"values"`
	Rows        []map[string]any     `json:"rows"`
	FiscalStart int                  `json:"fiscalStart"`
	Formula     *Node                `json:"formula"`
	Forms       any                  `json:"forms"`
	Expect      any                  `json:"expect"`
	Error       string               `json:"error"`
}

func loadFormulaCases(t *testing.T) []formulaCase {
	t.Helper()
	raw, err := os.ReadFile(formulaCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []formulaCase `json:"cases"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&table); err != nil {
		t.Fatal(err)
	}
	return table.Cases
}

// tableCtx compiles a case's formula over a one-table query: {col: x} is
// column x of t, and aggregates run over all of t's rows, as a group row's
// aggregates run over the group's rows.
type tableCtx struct {
	types  map[string]FieldType
	params dbx.Params
	fiscal int
}

func (c *tableCtx) col(id, at string) (expr, error) {
	typ, ok := c.types[id]
	if !ok {
		return expr{}, invalid(at, "unknown column "+id)
	}
	return expr{sql: "t." + id, typ: typ}, nil
}

func (c *tableCtx) path(Path, string) (expr, error) {
	return expr{}, fmt.Errorf("no paths in the table")
}
func (c *tableCtx) param(string, string) (expr, error) {
	return expr{}, fmt.Errorf("no params in the table")
}
func (c *tableCtx) subtotal(string, string) (expr, error) {
	return expr{}, fmt.Errorf("no subtotals in the table")
}
func (c *tableCtx) window(string, *Node, int, string) (expr, error) {
	return expr{}, fmt.Errorf("no windows in the table")
}
func (c *tableCtx) exists(*Node, string) (expr, error) {
	return expr{}, fmt.Errorf("no links in the table")
}
func (c *tableCtx) filter() bool { return false }

func (c *tableCtx) aggregate(op Aggregate, arg *Node, scale int, at string) (expr, error) {
	e, err := compileFormula(c, arg, at+".args.0")
	if err != nil {
		return expr{}, err
	}
	if err := checkAggregate(op, e.typ, scale, at+".args.0"); err != nil {
		return expr{}, err
	}
	return expr{sql: aggregateSQL(op, e.sql, scale), typ: aggregateType(op, e.typ, scale)}, nil
}

func (c *tableCtx) bind(v any) string {
	name := fmt.Sprintf("p%d", len(c.params))
	c.params[name] = v
	return "{:" + name + "}"
}

func (c *tableCtx) fiscalStart() string {
	if c.fiscal == 0 {
		return c.bind(int64(1))
	}
	return c.bind(int64(c.fiscal))
}

// jsonValue turns a decoded case value into what SQLite binds: a whole
// number binds as an integer.
func jsonValue(v any) any {
	if n, ok := v.(json.Number); ok {
		return numberValue(n)
	}
	return v
}

func runFormulaCase(t *testing.T, app core.App, c formulaCase) (any, error) {
	t.Helper()
	ctx := &tableCtx{types: c.Types, params: dbx.Params{}, fiscal: c.FiscalStart}
	e, err := compileFormula(ctx, c.Formula, "formula")
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	cols := make([]string, 0, len(c.Types))
	for name := range c.Types {
		cols = append(cols, name)
	}
	sort.Strings(cols)
	rows := c.Rows
	if c.Values != nil {
		rows = []map[string]any{c.Values}
	}
	table := "WITH t(_) AS (VALUES (NULL)) "
	if len(cols) > 0 {
		tuples := make([]string, 0, len(rows))
		for i, row := range rows {
			slots := make([]string, len(cols))
			for j, name := range cols {
				key := fmt.Sprintf("r%d_%d", i, j)
				ctx.params[key] = jsonValue(row[name])
				slots[j] = "{:" + key + "}"
			}
			tuples = append(tuples, "("+strings.Join(slots, ", ")+")")
		}
		body := "VALUES " + strings.Join(tuples, ", ")
		if len(tuples) == 0 {
			nulls := strings.TrimSuffix(strings.Repeat("NULL, ", len(cols)), ", ")
			body = "SELECT " + nulls + " WHERE 0"
		}
		table = "WITH t(" + strings.Join(cols, ", ") + ") AS (" + body + ") "
	}
	var out struct {
		V any `db:"v"`
	}
	err = app.DB().NewQuery(table + "SELECT " + e.sql + " AS v FROM t").Bind(ctx.params).One(&out)
	return out.V, err
}

// sameValue compares a SQLite result with a JSON expectation: SQLite has no
// boolean (true is 1) and returns whole numbers as integers.
func sameValue(got, want any) bool {
	switch w := want.(type) {
	case nil:
		return got == nil
	case bool:
		g, ok := got.(int64)
		return ok && (g != 0) == w
	case json.Number:
		switch g := got.(type) {
		case int64:
			return string(w) == fmt.Sprint(g)
		case float64:
			f, err := w.Float64()
			return err == nil && f == g
		}
		return false
	case string:
		return got == w
	}
	return false
}

func TestFormulaCasesTheReportCompiler(t *testing.T) {
	app := newPlainApp(t)
	cases := loadFormulaCases(t)
	if len(cases) < 40 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := runFormulaCase(t, app, c)
			if c.Error != "" {
				if err == nil || !strings.Contains(err.Error(), c.Error) {
					t.Fatalf("err = %v, want %q", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !sameValue(got, c.Expect) {
				t.Fatalf("got %#v, want %v", got, c.Expect)
			}
		})
	}
}
```

`$WS/tinycld/core/server/reports/formula_test.go`:

```go
package reports

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

func parseNode(t *testing.T, raw string) *Node {
	t.Helper()
	var n Node
	if err := json.Unmarshal([]byte(raw), &n); err != nil {
		t.Fatalf("parse %s: %v", raw, err)
	}
	return &n
}

func TestCompileFormulaRefusesWhatCannotBeComputed(t *testing.T) {
	types := map[string]FieldType{"amount": Money, "n": Number, "name": Text, "day": Date, "ok": Bool}
	cases := map[string]struct {
		formula, at, want string
	}{
		"amount times amount":     {`{"op":"mul","args":[{"col":"amount"},{"col":"amount"}]}`, "f", "an amount times an amount"},
		"div without scale":       {`{"op":"div","args":[{"col":"n"},{"value":2}]}`, "f.scale", "div needs a scale from 0 to 6"},
		"scale too large":         {`{"op":"round","args":[{"col":"n"}],"scale":7}`, "f.scale", "needs a scale from 0 to 6"},
		"amount by number, cents": {`{"op":"div","args":[{"col":"amount"},{"col":"n"}],"scale":2}`, "f.scale", "use scale 0"},
		"and of a number":         {`{"op":"and","args":[{"col":"ok"},{"col":"n"}]}`, "f.args.1", "and needs conditions"},
		"not of a number":         {`{"op":"not","args":[{"col":"n"}]}`, "f.args.0", "not needs a condition"},
		"unknown operator":        {`{"op":"pow","args":[{"col":"n"},{"value":2}]}`, "f", `unknown operator "pow"`},
		"two kinds in one node":   {`{"col":"n","value":2}`, "f", "one of op, col, path"},
		"list outside in":         {`{"op":"add","args":[{"value":[1,2]},{"value":1}]}`, "f.args.0", "fits only between or in"},
		"if of two kinds":         {`{"op":"if","args":[{"col":"ok"},{"value":"x"},{"value":1}]}`, "f", "both results of if"},
		"eq of text and number":   {`{"op":"eq","args":[{"col":"name"},{"col":"n"}]}`, "f", "compares values of one kind"},
		"addDays of a number":     {`{"op":"addDays","args":[{"col":"n"},{"value":1}]}`, "f", "needs a date and a number"},
		"sum of text":             {`{"op":"sum","args":[{"col":"name"}]}`, "f.args.0", "sum needs numbers"},
		"avg of amounts to cents": {`{"op":"avg","args":[{"col":"amount"}],"scale":2}`, "f.args.0", "use scale 0"},
		"link on a plain op":      {`{"op":"eq","args":[{"col":"n"},{"value":1}],"link":[{"link":"animal"}]}`, "f", "only exists and notExists"},
		"window with two values":  {`{"op":"runningSum","args":[{"col":"n"},{"col":"n"}]}`, "f", "takes one value"},
		"wrong arity":             {`{"op":"sub","args":[{"col":"n"}]}`, "f", "sub takes 2 values"},
		"unknown column":          {`{"col":"nope"}`, "f", "unknown column nope"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := &tableCtx{types: types, params: dbx.Params{}}
			_, err := compileFormula(ctx, parseNode(t, c.formula), "f")
			requireSpecError(t, err, 400, c.at, c.want)
		})
	}
}

func TestCompileFormulaLimitsDepth(t *testing.T) {
	raw := `{"col":"n"}`
	for range maxFormulaDepth + 2 {
		raw = `{"op":"add","args":[` + raw + `,{"value":1}]}`
	}
	ctx := &tableCtx{types: map[string]FieldType{"n": Number}, params: dbx.Params{}}
	_, err := compileFormula(ctx, parseNode(t, raw), "f")
	if err == nil || !strings.Contains(err.Error(), "at most 32 levels") {
		t.Fatalf("err = %v", err)
	}
}

func TestCompileFormulaTypes(t *testing.T) {
	types := map[string]FieldType{"amount": Money, "n": Number, "day": DateTime}
	cases := map[string]FieldType{
		`{"op":"add","args":[{"col":"amount"},{"value":100}]}`:              Money,
		`{"op":"mul","args":[{"col":"amount"},{"col":"n"}]}`:                Money,
		`{"op":"div","args":[{"col":"amount"},{"col":"amount"}],"scale":2}`: Number,
		`{"op":"div","args":[{"col":"amount"},{"col":"n"}],"scale":0}`:      Money,
		`{"op":"avg","args":[{"col":"amount"}],"scale":0}`:                  Money,
		`{"op":"count","args":[{"col":"day"}]}`:                             Number,
		`{"op":"addMonths","args":[{"col":"day"},{"value":1}]}`:             Date,
		`{"op":"coalesce","args":[{"value":null},{"col":"n"}]}`:             Number,
	}
	for raw, want := range cases {
		ctx := &tableCtx{types: types, params: dbx.Params{}}
		e, err := compileFormula(ctx, parseNode(t, raw), "f")
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if e.typ != want {
			t.Errorf("%s: type %q, want %q", raw, e.typ, want)
		}
	}
}

func TestLiteralsBindAndNeverInline(t *testing.T) {
	ctx := &tableCtx{types: map[string]FieldType{"name": Text}, params: dbx.Params{}}
	e, err := compileFormula(ctx, parseNode(t, `{"op":"eq","args":[{"col":"name"},{"value":"x'); DROP TABLE users; --"}]}`), "f")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(e.sql, "DROP") || ctx.params["p0"] != "x'); DROP TABLE users; --" {
		t.Fatalf("sql %q params %v", e.sql, ctx.params)
	}
}
```

`$WS/tinycld/core/server/forms/formula_cases_test.go`:

```go
package forms

import (
	"encoding/json"
	"os"
	"testing"
)

// The shared formula table: the report compiler runs every case
// (core/server/reports/formula_cases_test.go); the forms engines, Go here and
// TS in core/lib/forms/__tests__/formula-cases.test.ts, run each case that
// carries a "forms" formula. A shared case's expected value holds for both.
const formulaCasesPath = "../../lib/forms/fixtures/formula-cases.json"

type sharedFormulaCase struct {
	Name   string           `json:"name"`
	Values map[string]any   `json:"values"`
	Rows   []map[string]any `json:"rows"`
	Forms  any              `json:"forms"`
	Expect any              `json:"expect"`
}

func TestSharedFormulaCases_FormsEngine(t *testing.T) {
	raw, err := os.ReadFile(formulaCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []sharedFormulaCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	shared := 0
	for _, c := range table.Cases {
		if c.Forms == nil {
			continue
		}
		shared++
		t.Run(c.Name, func(t *testing.T) {
			var refs exprRefs
			if msg := parseExpr(c.Forms, &refs); msg != "" {
				t.Fatalf("the forms formula is not valid: %s", msg)
			}
			scope := map[string]any{}
			for k, v := range c.Values {
				scope[k] = v
			}
			if c.Rows != nil {
				rows := make([]any, len(c.Rows))
				for i, r := range c.Rows {
					rows[i] = r
				}
				scope["rows"] = rows
			}
			want, ok := c.Expect.(float64)
			if !ok {
				t.Fatalf("a shared case expects a number, got %#v", c.Expect)
			}
			if got := evalCompute(c.Forms, scope); got != want {
				t.Fatalf("evalCompute = %v, want %v", got, want)
			}
		})
	}
	if shared < 20 {
		t.Fatalf("only %d cases are shared with the report compiler", shared)
	}
}
```

`$WS/tinycld/core/lib/forms/__tests__/formula-cases.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { computeExprSchema, evalCompute } from '../expression'
import table from '../fixtures/formula-cases.json'

// The shared formula table: the report compiler runs every case
// (core/server/reports/formula_cases_test.go); the forms engines, TS here and
// Go in core/server/forms/formula_cases_test.go, run each case that carries a
// "forms" formula. A shared case's expected value holds for both.
const caseSchema = z.object({
    name: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    forms: z.unknown().optional(),
    expect: z.unknown().optional(),
})

const shared = z
    .array(caseSchema)
    .parse(table.cases)
    .filter(c => c.forms !== undefined)

describe('the shared formula table in the forms engine', () => {
    it('shares enough cases with the report compiler', () => {
        expect(shared.length).toBeGreaterThanOrEqual(20)
    })

    for (const c of shared) {
        it(c.name, () => {
            const formula = computeExprSchema.parse(c.forms)
            const scope = { ...c.values, ...(c.rows ? { rows: c.rows } : {}) }
            expect(evalCompute(formula, scope)).toBe(c.expect)
        })
    }
})
```

- [ ] **Step 3: Run the tests to verify they fail, and that the forms engines already pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: expr`, `undefined: compileFormula`, …

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -run SharedFormulaCases ./forms/...`
Expected: `ok  tinycld.org/core/forms` (the forms engine needs no change; its 22 shared cases pass).

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH vitest run core/lib/forms/__tests__/formula-cases.test.ts`
Expected: 23 passed (22 cases and the count check).

- [ ] **Step 4: Write the compiler**

`$WS/tinycld/core/server/reports/formula.go`:

```go
package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// expr is one compiled formula node: its SQL and what the compiler knows
// about it.
type expr struct {
	sql string
	// typ is the value's type; "" is a NULL literal, which fits any type.
	typ FieldType
	// lo and hi hold a dateRange param's bounds; sql is empty for it.
	rng    bool
	lo, hi string
	// list is a list of values for in: sql is "(?, ?, …)".
	list bool
	// lit is a literal value: a number literal adopts the other operand's
	// kind, so amount + 100 stays an amount.
	lit bool
	// unset is a param with no value: in a filter, a condition on it
	// matches every row.
	unset bool
	agg   bool // contains an aggregate
	win   bool // contains a window function
}

// fctx says what a formula's leaves and context-bound operators mean where
// the formula is compiled: a filter over joined rows, a detail row, a group
// row, a layout row, or the formula-table harness.
type fctx interface {
	col(id, at string) (expr, error)
	path(p Path, at string) (expr, error)
	param(id, at string) (expr, error)
	subtotal(id, at string) (expr, error)
	aggregate(op Aggregate, arg *Node, scale int, at string) (expr, error)
	window(op string, arg *Node, scale int, at string) (expr, error)
	exists(n *Node, at string) (expr, error)
	// bind adds a value to the statement's parameters and returns its
	// placeholder.
	bind(v any) string
	// fiscalStart is the SQL of the base source's fiscal start month.
	fiscalStart() string
	// filter is true while compiling a filter.
	filter() bool
}

// aggregate and window receive the operator node's path; the value they
// total is at path + ".args.0".

// Formula limits: a tree deeper or larger than these is refused before it
// reaches SQLite.
const (
	maxFormulaDepth = 32
	maxFormulaNodes = 1000
)

func compileFormula(c fctx, n *Node, at string) (expr, error) {
	count := 0
	return compileNode(c, n, at, 0, &count)
}

func compileNode(c fctx, n *Node, at string, depth int, count *int) (expr, error) {
	if n == nil {
		return expr{}, invalid(at, "a formula node is missing")
	}
	*count++
	if depth > maxFormulaDepth || *count > maxFormulaNodes {
		return expr{}, invalid(at, fmt.Sprintf("a formula has at most %d levels and %d nodes", maxFormulaDepth, maxFormulaNodes))
	}
	if kinds := nodeKinds(n); kinds != 1 {
		return expr{}, invalid(at, "a formula node is one of op, col, path, param, value or subtotal")
	}
	switch {
	case n.Col != "":
		return c.col(n.Col, at)
	case n.Path != nil:
		return c.path(n.Path, at+".path")
	case n.Param != "":
		return c.param(n.Param, at)
	case n.Subtotal != "":
		return c.subtotal(n.Subtotal, at)
	case n.Value != nil:
		return literal(c, n.Value, at)
	}
	if n.Link != nil || n.Where != nil {
		if n.Op != "exists" && n.Op != "notExists" {
			return expr{}, invalid(at, "only exists and notExists take a link and a where")
		}
	}
	switch n.Op {
	case "exists", "notExists":
		e, err := c.exists(n, at)
		if err != nil || n.Op == "exists" {
			return e, err
		}
		e.sql = "(NOT " + e.sql + ")"
		return e, nil
	case "sum", "count", "countDistinct", "avg":
		return aggregateNode(c, Aggregate(n.Op), n, at)
	case "min", "max":
		if len(n.Args) == 1 {
			return aggregateNode(c, Aggregate(n.Op), n, at)
		}
	case "runningSum", "percentOfParent", "percentOfTotal":
		if len(n.Args) != 1 {
			return expr{}, invalid(at, n.Op+" takes one value")
		}
		scale := 0
		if n.Op != "runningSum" {
			s, err := needScale(n, at)
			if err != nil {
				return expr{}, err
			}
			scale = s
		}
		e, err := c.window(n.Op, n.Args[0], scale, at)
		e.win = true
		return e, err
	}
	args := make([]expr, len(n.Args))
	for i, a := range n.Args {
		e, err := compileNode(c, a, fmt.Sprintf("%s.args.%d", at, i), depth+1, count)
		if err != nil {
			return expr{}, err
		}
		args[i] = e
	}
	e, err := operator(c, n, args, at)
	if err != nil {
		return expr{}, err
	}
	for _, a := range args {
		e.agg = e.agg || a.agg
		e.win = e.win || a.win
	}
	return e, nil
}

func nodeKinds(n *Node) int {
	kinds := 0
	for _, set := range []bool{n.Op != "", n.Col != "", n.Path != nil, n.Param != "", n.Value != nil, n.Subtotal != ""} {
		if set {
			kinds++
		}
	}
	return kinds
}

func aggregateNode(c fctx, op Aggregate, n *Node, at string) (expr, error) {
	if len(n.Args) != 1 {
		return expr{}, invalid(at, string(op)+" takes one value")
	}
	scale := 0
	if op == Avg {
		s, err := needScale(n, at)
		if err != nil {
			return expr{}, err
		}
		scale = s
	}
	e, err := c.aggregate(op, n.Args[0], scale, at)
	e.agg = true
	return e, err
}

func needScale(n *Node, at string) (int, error) {
	if n.Scale == nil || *n.Scale < 0 || *n.Scale > MaxScale {
		return 0, invalid(at+".scale", fmt.Sprintf("%s needs a scale from 0 to %d", n.Op, MaxScale))
	}
	return *n.Scale, nil
}

// literal binds a {value}. A whole number binds as an integer, so money
// arithmetic stays exact.
func literal(c fctx, raw json.RawMessage, at string) (expr, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return expr{}, invalid(at, "a value is not valid JSON")
	}
	switch x := v.(type) {
	case nil:
		return expr{sql: "NULL", lit: true}, nil
	case bool:
		return expr{sql: c.bind(x), typ: Bool, lit: true}, nil
	case string:
		return expr{sql: c.bind(x), typ: Text, lit: true}, nil
	case json.Number:
		return expr{sql: c.bind(numberValue(x)), typ: Number, lit: true}, nil
	case []any:
		parts := make([]string, 0, len(x))
		var typ FieldType
		for _, item := range x {
			switch y := item.(type) {
			case string:
				parts = append(parts, c.bind(y))
				typ = Text
			case json.Number:
				parts = append(parts, c.bind(numberValue(y)))
				typ = Number
			default:
				return expr{}, invalid(at, "a value list holds text or numbers")
			}
		}
		return expr{sql: "(" + strings.Join(parts, ", ") + ")", typ: typ, list: true, lit: true}, nil
	}
	return expr{}, invalid(at, "a value is text, a number, true, false, null or a list")
}

func numberValue(n json.Number) any {
	if i, err := strconv.ParseInt(string(n), 10, 64); err == nil {
		return i
	}
	f, _ := n.Float64()
	return f
}

func isNumeric(t FieldType) bool {
	return t == Number || t == Money || t == Percent || t == Bool || t == ""
}

func isDateLike(t FieldType) bool {
	return t == Date || t == DateTime || t == Text || t == ""
}

// num coalesces an arithmetic operand: a blank counts as zero, as in the
// forms engine.
func num(e expr) string { return "COALESCE(" + e.sql + ", 0)" }

func operator(c fctx, n *Node, args []expr, at string) (expr, error) {
	argc := func(min, max int) error {
		if len(args) < min || (max >= 0 && len(args) > max) {
			if min == max {
				return invalid(at, fmt.Sprintf("%s takes %d values", n.Op, min))
			}
			return invalid(at, fmt.Sprintf("%s takes at least %d values", n.Op, min))
		}
		return nil
	}
	numeric := func() error {
		for i, a := range args {
			if !isNumeric(a.typ) || a.list || a.rng {
				return invalid(fmt.Sprintf("%s.args.%d", at, i), n.Op+" needs numbers")
			}
		}
		return nil
	}
	if c.filter() && conditionOps[n.Op] {
		for _, a := range args {
			if a.unset {
				return expr{sql: "1", typ: Bool}, nil
			}
		}
	}
	for i, a := range args {
		if (a.rng && n.Op != "between") || (a.list && n.Op != "in") {
			return expr{}, invalid(fmt.Sprintf("%s.args.%d", at, i), "a range or a list fits only between or in")
		}
	}
	switch n.Op {
	case "add", "sub":
		max := -1
		if n.Op == "sub" {
			max = 2
		}
		if err := argc(2, max); err != nil {
			return expr{}, err
		}
		if err := numeric(); err != nil {
			return expr{}, err
		}
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = num(a)
		}
		sep := " + "
		if n.Op == "sub" {
			sep = " - "
		}
		return expr{sql: "(" + strings.Join(parts, sep) + ")", typ: sumType(args)}, nil
	case "mul":
		if err := argc(2, -1); err != nil {
			return expr{}, err
		}
		if err := numeric(); err != nil {
			return expr{}, err
		}
		parts := make([]string, len(args))
		amounts := 0
		for i, a := range args {
			parts[i] = num(a)
			if a.typ == Money {
				amounts++
			}
		}
		product := "(" + strings.Join(parts, " * ") + ")"
		switch {
		case amounts > 1:
			return expr{}, invalid(at, "an amount times an amount is not an amount")
		case amounts == 1:
			// Whole cents: a product with a fraction of a cent rounds.
			return expr{sql: "tc_round(" + product + ", 0)", typ: Money}, nil
		}
		return expr{sql: product, typ: Number}, nil
	case "div":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if err := numeric(); err != nil {
			return expr{}, err
		}
		scale, err := needScale(n, at)
		if err != nil {
			return expr{}, err
		}
		typ := Number
		if args[0].typ == Money && args[1].typ != Money {
			if scale != 0 {
				return expr{}, invalid(at+".scale", "an amount divided by a number keeps whole cents: use scale 0")
			}
			typ = Money
		}
		return expr{sql: fmt.Sprintf("tc_div(%s, %s, %d)", num(args[0]), num(args[1]), scale), typ: typ}, nil
	case "round":
		if err := argc(1, 1); err != nil {
			return expr{}, err
		}
		if err := numeric(); err != nil {
			return expr{}, err
		}
		scale, err := needScale(n, at)
		if err != nil {
			return expr{}, err
		}
		typ := args[0].typ
		if typ == Bool || typ == "" {
			typ = Number
		}
		return expr{sql: fmt.Sprintf("tc_round(%s, %d)", num(args[0]), scale), typ: typ}, nil
	case "min", "max":
		if err := argc(2, -1); err != nil {
			return expr{}, err
		}
		if err := numeric(); err != nil {
			return expr{}, err
		}
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = num(a)
		}
		return expr{sql: n.Op + "(" + strings.Join(parts, ", ") + ")", typ: sumType(args)}, nil
	case "eq", "ne":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if !comparable(args[0].typ, args[1].typ) {
			return expr{}, invalid(at, fmt.Sprintf("%s compares values of one kind, not %s and %s", n.Op, args[0].typ, args[1].typ))
		}
		op := " IS "
		if n.Op == "ne" {
			op = " IS NOT "
		}
		return expr{sql: "(" + args[0].sql + op + args[1].sql + ")", typ: Bool}, nil
	case "lt", "lte", "gt", "gte":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if !ordered(args[0].typ, args[1].typ) {
			return expr{}, invalid(at, fmt.Sprintf("%s compares numbers, dates or text, not %s and %s", n.Op, args[0].typ, args[1].typ))
		}
		return expr{sql: "(" + args[0].sql + " " + comparisons[n.Op] + " " + args[1].sql + ")", typ: Bool}, nil
	case "between":
		return between(args, at)
	case "in":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if !args[1].list {
			return expr{}, invalid(at+".args.1", "in needs a list")
		}
		if args[1].sql == "()" {
			return expr{sql: "0", typ: Bool}, nil
		}
		return expr{sql: "(" + args[0].sql + " IN " + args[1].sql + ")", typ: Bool}, nil
	case "and", "or":
		if err := argc(2, -1); err != nil {
			return expr{}, err
		}
		parts := make([]string, len(args))
		for i, a := range args {
			if a.typ != Bool && a.typ != "" {
				return expr{}, invalid(fmt.Sprintf("%s.args.%d", at, i), n.Op+" needs conditions")
			}
			parts[i] = a.sql
		}
		return expr{sql: "(" + strings.Join(parts, " "+strings.ToUpper(n.Op)+" ") + ")", typ: Bool}, nil
	case "not":
		if err := argc(1, 1); err != nil {
			return expr{}, err
		}
		if args[0].typ != Bool {
			return expr{}, invalid(at+".args.0", "not needs a condition")
		}
		// A condition on a blank is false, so its negation is true.
		return expr{sql: "(NOT COALESCE(" + args[0].sql + ", 0))", typ: Bool}, nil
	case "concat":
		if err := argc(1, -1); err != nil {
			return expr{}, err
		}
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = "COALESCE(" + a.sql + ", '')"
		}
		return expr{sql: "(" + strings.Join(parts, " || ") + ")", typ: Text}, nil
	case "upper", "lower":
		if err := argc(1, 1); err != nil {
			return expr{}, err
		}
		return expr{sql: n.Op + "(" + args[0].sql + ")", typ: Text}, nil
	case "contains", "startsWith":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if n.Op == "contains" {
			return expr{sql: "(instr(lower(" + args[0].sql + "), lower(" + args[1].sql + ")) > 0)", typ: Bool}, nil
		}
		return expr{sql: "(substr(lower(" + args[0].sql + "), 1, length(" + args[1].sql + ")) = lower(" + args[1].sql + "))", typ: Bool}, nil
	case "year", "quarter", "month", "fiscalYear", "fiscalPeriod":
		if err := argc(1, 1); err != nil {
			return expr{}, err
		}
		if !isDateLike(args[0].typ) {
			return expr{}, invalid(at+".args.0", n.Op+" needs a date")
		}
		return expr{sql: datePart(c, n.Op, args[0].sql), typ: Number}, nil
	case "addDays", "addMonths":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if !isDateLike(args[0].typ) || !isNumeric(args[1].typ) {
			return expr{}, invalid(at, n.Op+" needs a date and a number")
		}
		count := "CAST(" + num(args[1]) + " AS INTEGER)"
		if n.Op == "addDays" {
			return expr{sql: "date(" + args[0].sql + ", printf('%+d days', " + count + "))", typ: Date}, nil
		}
		return expr{sql: "tc_add_months(" + args[0].sql + ", " + count + ")", typ: Date}, nil
	case "diffDays":
		if err := argc(2, 2); err != nil {
			return expr{}, err
		}
		if !isDateLike(args[0].typ) || !isDateLike(args[1].typ) {
			return expr{}, invalid(at, "diffDays needs two dates")
		}
		return expr{sql: "CAST(julianday(substr(" + args[1].sql + ", 1, 10)) - julianday(substr(" + args[0].sql + ", 1, 10)) AS INTEGER)", typ: Number}, nil
	case "if":
		if err := argc(3, 3); err != nil {
			return expr{}, err
		}
		if args[0].typ != Bool {
			return expr{}, invalid(at+".args.0", "if needs a condition first")
		}
		typ, ok := commonType(args[1], args[2])
		if !ok {
			return expr{}, invalid(at, "both results of if are of one kind")
		}
		return expr{sql: "(CASE WHEN " + args[0].sql + " THEN " + args[1].sql + " ELSE " + args[2].sql + " END)", typ: typ}, nil
	case "case":
		if err := argc(2, -1); err != nil {
			return expr{}, err
		}
		var b strings.Builder
		b.WriteString("(CASE")
		results := []expr{}
		for i := 0; i+1 < len(args); i += 2 {
			if args[i].typ != Bool {
				return expr{}, invalid(fmt.Sprintf("%s.args.%d", at, i), "case takes condition and result pairs")
			}
			b.WriteString(" WHEN " + args[i].sql + " THEN " + args[i+1].sql)
			results = append(results, args[i+1])
		}
		if len(args)%2 == 1 {
			b.WriteString(" ELSE " + args[len(args)-1].sql)
			results = append(results, args[len(args)-1])
		}
		b.WriteString(" END)")
		typ, ok := commonType(results...)
		if !ok {
			return expr{}, invalid(at, "every result of case is of one kind")
		}
		return expr{sql: b.String(), typ: typ}, nil
	case "coalesce":
		if err := argc(1, -1); err != nil {
			return expr{}, err
		}
		typ, ok := commonType(args...)
		if !ok {
			return expr{}, invalid(at, "coalesce takes values of one kind")
		}
		if len(args) == 1 {
			return expr{sql: args[0].sql, typ: typ}, nil
		}
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = a.sql
		}
		return expr{sql: "COALESCE(" + strings.Join(parts, ", ") + ")", typ: typ}, nil
	case "isEmpty":
		if err := argc(1, 1); err != nil {
			return expr{}, err
		}
		return expr{sql: "(" + args[0].sql + " IS NULL OR " + args[0].sql + " = '')", typ: Bool}, nil
	}
	return expr{}, invalid(at, fmt.Sprintf("unknown operator %q", n.Op))
}

// conditionOps match every row in a filter when one of their values is an
// unset param, so an empty filter chip filters nothing.
var conditionOps = map[string]bool{
	"eq": true, "ne": true, "lt": true, "lte": true, "gt": true, "gte": true,
	"between": true, "in": true, "contains": true, "startsWith": true,
}

var comparisons = map[string]string{"lt": "<", "lte": "<=", "gt": ">", "gte": ">="}

func between(args []expr, at string) (expr, error) {
	switch {
	case len(args) == 2 && args[1].rng:
		x := args[0]
		if !isDateLike(x.typ) {
			return expr{}, invalid(at+".args.0", "a date range holds dates")
		}
		day := "substr(" + x.sql + ", 1, 10)"
		return expr{sql: "(" + day + " >= " + args[1].lo + " AND " + day + " <= " + args[1].hi + ")", typ: Bool}, nil
	case len(args) == 3:
		if !ordered(args[0].typ, args[1].typ) || !ordered(args[0].typ, args[2].typ) {
			return expr{}, invalid(at, "between compares numbers, dates or text")
		}
		return expr{sql: "(" + args[0].sql + " >= " + args[1].sql + " AND " + args[0].sql + " <= " + args[2].sql + ")", typ: Bool}, nil
	}
	return expr{}, invalid(at, "between takes a value and a date range param, or a value, a low and a high")
}

func datePart(c fctx, op, day string) string {
	switch op {
	case "year":
		return "CAST(substr(" + day + ", 1, 4) AS INTEGER)"
	case "month":
		return "CAST(substr(" + day + ", 6, 2) AS INTEGER)"
	case "quarter":
		return "((CAST(substr(" + day + ", 6, 2) AS INTEGER) + 2) / 3)"
	case "fiscalYear":
		return "tc_fiscal_year(" + day + ", " + c.fiscalStart() + ")"
	}
	return "tc_fiscal_period(" + day + ", " + c.fiscalStart() + ")"
}

// sumType is the type of a sum, difference, min or max: money when any
// operand is money, else percent when any is a percent, else number.
func sumType(args []expr) FieldType {
	typ := Number
	for _, a := range args {
		if a.typ == Money {
			return Money
		}
		if a.typ == Percent {
			typ = Percent
		}
	}
	return typ
}

func comparable(a, b FieldType) bool {
	if a == "" || b == "" || a == b {
		return true
	}
	if isNumeric(a) && isNumeric(b) {
		return true
	}
	return isDateLike(a) && isDateLike(b) || textual(a) && textual(b)
}

func textual(t FieldType) bool {
	return t == Text || t == Select || t == Relation
}

func ordered(a, b FieldType) bool {
	if isNumeric(a) && isNumeric(b) {
		return true
	}
	return (isDateLike(a) || textual(a)) && (isDateLike(b) || textual(b))
}

// commonType is the type every non-NULL value shares.
func commonType(values ...expr) (FieldType, bool) {
	var typ FieldType
	for _, v := range values {
		switch {
		case v.typ == "":
		case typ == "":
			typ = v.typ
		case !comparable(typ, v.typ):
			return "", false
		case v.typ == Money:
			typ = Money
		}
	}
	return typ, true
}

// aggregateSQL is an aggregate of a value over the rows of a group. A sum of
// no rows is 0, as in the forms engine; SQLite's sum() keeps integers exact
// and raises "integer overflow" instead of rounding. An average divides with
// tc_div, so money averages to whole cents.
func aggregateSQL(op Aggregate, arg string, scale int) string {
	switch op {
	case Sum:
		return "COALESCE(sum(" + arg + "), 0)"
	case Count:
		return "count(" + arg + ")"
	case CountDistinct:
		return "count(DISTINCT " + arg + ")"
	case Min, Max:
		return string(op) + "(" + arg + ")"
	}
	return fmt.Sprintf("(CASE WHEN count(%[1]s) = 0 THEN NULL ELSE tc_div(sum(%[1]s), count(%[1]s), %[2]d) END)", arg, scale)
}

// aggregateType is the type of an aggregate of a value of type t.
func aggregateType(op Aggregate, t FieldType, scale int) FieldType {
	switch op {
	case Count, CountDistinct:
		return Number
	case Avg:
		if t == Money && scale == 0 {
			return Money
		}
		return Number
	}
	if t == Bool {
		return Number
	}
	return t
}

// checkAggregate refuses an aggregate a value of type t cannot have.
func checkAggregate(op Aggregate, t FieldType, scale int, at string) error {
	switch op {
	case Sum, Avg:
		if !isNumeric(t) {
			return invalid(at, fmt.Sprintf("%s needs numbers", op))
		}
		if op == Avg && t == Money && scale != 0 {
			return invalid(at, "an average of amounts keeps whole cents: use scale 0")
		}
	case Count, CountDistinct, Min, Max:
	default:
		return invalid(at, fmt.Sprintf("unknown aggregate %q", op))
	}
	return nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports` (all 65 cases of the table pass).

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH biome check core/lib/forms/fixtures/formula-cases.json core/lib/forms/__tests__/formula-cases.test.ts && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH tinycld-pkg typecheck`
Expected: no Biome findings; tsc passes.

- [ ] **Step 6: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/formula.go \
  core/server/reports/formula_test.go \
  core/server/reports/formula_cases_test.go \
  core/server/forms/formula_cases_test.go \
  core/lib/forms/fixtures/formula-cases.json \
  core/lib/forms/__tests__/formula-cases.test.ts
git commit -m "feat(core): report formula compiler and a formula table shared with the forms engine"
```

---

### Task 7: Params and period presets

**Files:**
- Create: `$WS/tinycld/core/server/reports/params.go`
- Test: `$WS/tinycld/core/server/reports/params_test.go`

The presets are the shell's (`books/tinycld/books/lib/report-period.ts`, `resolvePreset`), in camelCase as the spec writes them (`thisFiscalYear`): quarters are fiscal quarters, counted from the fiscal year's first month.

**Interfaces:**
- Consumes: `ParamDef`, `invalid` (Task 5); `fctx`, `expr`, `numberValue` (Task 6).
- Produces: param type constants `ParamDate`, `ParamAsOf`, `ParamDateRange`, `ParamChoice`, `ParamText`, `ParamNumber`; `var idRe` (ids of letters, digits and `_`, used for columns and groups too); `type paramValue struct{ typ string; multiple, unset bool; value any; list []string; from, to string }`; `type periodContext struct{ today time.Time; fiscalStart int }`; `func checkParamDefs(defs []ParamDef) *SpecError`; `func resolveParams(defs []ParamDef, given map[string]json.RawMessage, pc periodContext) (map[string]paramValue, *SpecError)`; `func isDay(s string) bool`; `func rangeDays(preset string, pc periodContext) (string, string)`; `func asOfDay(preset string, pc periodContext) string`; `func paramExpr(c fctx, v paramValue) expr` (a date range is `rng` with `lo`/`hi`, a multiple choice is a `list`, an unset param is `unset`).

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/params_test.go`:

```go
package reports

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func day(s string) time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestRangePresetsMatchTheShell(t *testing.T) {
	july := periodContext{today: day("2026-08-15"), fiscalStart: 7}
	january := periodContext{today: day("2026-02-10"), fiscalStart: 1}
	cases := []struct {
		preset   string
		pc       periodContext
		from, to string
	}{
		{"today", july, "2026-08-15", "2026-08-15"},
		{"thisMonth", july, "2026-08-01", "2026-08-31"},
		{"thisMonthToDate", july, "2026-08-01", "2026-08-15"},
		{"thisQuarter", july, "2026-07-01", "2026-09-30"},
		{"thisQuarterToDate", july, "2026-07-01", "2026-08-15"},
		{"thisFiscalYear", july, "2026-07-01", "2027-06-30"},
		{"thisFiscalYearToDate", july, "2026-07-01", "2026-08-15"},
		{"lastMonth", july, "2026-07-01", "2026-07-31"},
		{"lastQuarter", july, "2026-04-01", "2026-06-30"},
		{"lastFiscalYear", july, "2025-07-01", "2026-06-30"},
		{"last12Months", july, "2025-08-01", "2026-07-31"},
		{"thisQuarter", january, "2026-01-01", "2026-03-31"},
		{"lastMonth", january, "2026-01-01", "2026-01-31"},
		{"lastFiscalYear", january, "2025-01-01", "2025-12-31"},
		{"lastQuarter", january, "2025-10-01", "2025-12-31"},
	}
	for _, c := range cases {
		from, to := rangeDays(c.preset, c.pc)
		if from != c.from || to != c.to {
			t.Errorf("%s (fiscal start %d): %s..%s, want %s..%s", c.preset, c.pc.fiscalStart, from, to, c.from, c.to)
		}
	}
}

func TestAsOfPresetsMatchTheShell(t *testing.T) {
	july := periodContext{today: day("2026-08-15"), fiscalStart: 7}
	cases := map[string]string{
		"today":               "2026-08-15",
		"endOfLastMonth":      "2026-07-31",
		"endOfLastQuarter":    "2026-06-30",
		"endOfLastFiscalYear": "2026-06-30",
	}
	for preset, want := range cases {
		if got := asOfDay(preset, july); got != want {
			t.Errorf("%s = %s, want %s", preset, got, want)
		}
	}
}

func raws(m map[string]string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for k, v := range m {
		out[k] = json.RawMessage(v)
	}
	return out
}

var zooParams = []ParamDef{
	{ID: "period", Type: ParamDateRange, Default: json.RawMessage(`{"preset":"thisMonth"}`)},
	{ID: "asOf", Type: ParamAsOf},
	{ID: "kind", Type: ParamChoice, Options: []Option{{Value: "hay", Label: "Hay"}, {Value: "fish", Label: "Fish"}}},
	{ID: "kinds", Type: ParamChoice, Multiple: true, Options: []Option{{Value: "hay", Label: "Hay"}, {Value: "fish", Label: "Fish"}}},
	{ID: "note", Type: ParamText},
	{ID: "min", Type: ParamNumber},
}

func TestResolveParamsTakesPostedThenDefaultThenUnset(t *testing.T) {
	pc := periodContext{today: day("2026-08-15"), fiscalStart: 1}
	got, err := resolveParams(zooParams, raws(map[string]string{
		"asOf": `{"preset":"endOfLastMonth"}`, "kinds": `["fish","hay"]`, "min": `2.5`, "note": `"x"`,
	}), pc)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]paramValue{
		"period": {typ: ParamDateRange, from: "2026-08-01", to: "2026-08-31"},
		"asOf":   {typ: ParamAsOf, value: "2026-07-31"},
		"kind":   {typ: ParamChoice, unset: true},
		"kinds":  {typ: ParamChoice, multiple: true, list: []string{"fish", "hay"}},
		"note":   {typ: ParamText, value: "x"},
		"min":    {typ: ParamNumber, value: 2.5},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestResolveParamsRefusesBadValues(t *testing.T) {
	pc := periodContext{today: day("2026-08-15"), fiscalStart: 1}
	cases := map[string]struct {
		given    map[string]string
		at, want string
	}{
		"undeclared":     {map[string]string{"color": `"red"`}, "params.color", `no param "color"`},
		"not a day":      {map[string]string{"asOf": `"2026-02-30"`}, "params.asOf", "YYYY-MM-DD"},
		"before 1900":    {map[string]string{"asOf": `"1899-12-31"`}, "params.asOf", "YYYY-MM-DD"},
		"range preset":   {map[string]string{"asOf": `{"preset":"thisMonth"}`}, "params.asOf", "a date or a preset"},
		"backward range": {map[string]string{"period": `{"from":"2026-02-01","to":"2026-01-01"}`}, "params.period", "on or before"},
		"range keys":     {map[string]string{"period": `{"from":"2026-02-01"}`}, "params.period", "a date range is"},
		"choice":         {map[string]string{"kind": `"meat"`}, "params.kind", "one of the param's options"},
		"multiple":       {map[string]string{"kinds": `"hay"`}, "params.kinds", "a list of the param's options"},
		"long text":      {map[string]string{"note": `"` + strings.Repeat("x", 501) + `"`}, "params.note", "at most 500"},
		"number":         {map[string]string{"min": `"2"`}, "params.min", "a number"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := resolveParams(zooParams, raws(c.given), pc)
			requireSpecError(t, err, 400, c.at, c.want)
		})
	}
}

func TestCheckParamDefsRefusesBadDeclarations(t *testing.T) {
	cases := map[string]struct {
		defs     []ParamDef
		at, want string
	}{
		"duplicate id":   {[]ParamDef{{ID: "a", Type: ParamText}, {ID: "a", Type: ParamText}}, "params.1.id", "unique id"},
		"unknown type":   {[]ParamDef{{ID: "a", Type: "color"}}, "params.0.type", `unknown param type "color"`},
		"choice options": {[]ParamDef{{ID: "a", Type: ParamChoice}}, "params.0.options", "lists its options"},
		"text options":   {[]ParamDef{{ID: "a", Type: ParamText, Options: []Option{{Value: "x", Label: "X"}}}}, "params.0", "only a choice param"},
		"bad default":    {[]ParamDef{{ID: "a", Type: ParamDateRange, Default: json.RawMessage(`{"preset":"someday"}`)}}, "params.0.default", "the preset is one of"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			requireSpecError(t, checkParamDefs(c.defs), 400, c.at, c.want)
		})
	}
	if err := checkParamDefs(zooParams); err != nil {
		t.Fatalf("zoo params: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: periodContext`, …

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/params.go`:

```go
package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"time"
)

// Param types. date and asOf hold one day (asOf offers as-of presets),
// dateRange a from and a to day, choice one option (or several with
// Multiple), text a string, number a number.
const (
	ParamDate      = "date"
	ParamAsOf      = "asOf"
	ParamDateRange = "dateRange"
	ParamChoice    = "choice"
	ParamText      = "text"
	ParamNumber    = "number"
)

const (
	maxParams    = 20
	maxParamText = 500
)

var idRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// rangePresets and asOfPresets are the shell's period presets.
var (
	rangePresets = []string{
		"today", "thisMonth", "thisMonthToDate", "thisQuarter", "thisQuarterToDate",
		"thisFiscalYear", "thisFiscalYearToDate", "lastMonth", "lastQuarter",
		"lastFiscalYear", "last12Months",
	}
	asOfPresets = []string{"today", "endOfLastMonth", "endOfLastQuarter", "endOfLastFiscalYear"}
)

// paramValue is a param resolved for one run.
type paramValue struct {
	typ      string
	multiple bool
	unset    bool
	value    any      // a day, a text, a number or one choice
	list     []string // a multiple choice
	from     string   // a date range
	to       string
}

// periodContext is what a preset is resolved against.
type periodContext struct {
	today       time.Time
	fiscalStart int
}

func checkParamDefs(defs []ParamDef) *SpecError {
	if len(defs) > maxParams {
		return invalid("params", fmt.Sprintf("a report has at most %d params", maxParams))
	}
	seen := map[string]bool{}
	for i, d := range defs {
		at := fmt.Sprintf("params.%d", i)
		if !idRe.MatchString(d.ID) || seen[d.ID] {
			return invalid(at+".id", "a param needs a unique id of letters, digits and _")
		}
		seen[d.ID] = true
		switch d.Type {
		case ParamDate, ParamAsOf, ParamDateRange, ParamText, ParamNumber:
			if len(d.Options) > 0 || d.Multiple {
				return invalid(at, "only a choice param has options")
			}
		case ParamChoice:
			if len(d.Options) == 0 {
				return invalid(at+".options", "a choice param lists its options")
			}
		default:
			return invalid(at+".type", fmt.Sprintf("unknown param type %q", d.Type))
		}
		if d.Default != nil {
			// A preset default must be a real preset; its day does not matter.
			anyDay := periodContext{today: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), fiscalStart: 1}
			if _, err := parseParam(d, d.Default, anyDay, at+".default"); err != nil {
				return err
			}
		}
	}
	return nil
}

// resolveParams gives every param its value for this run: the posted value,
// else its default, else unset. A posted id the spec does not declare is an
// error.
func resolveParams(defs []ParamDef, given map[string]json.RawMessage, pc periodContext) (map[string]paramValue, *SpecError) {
	out := map[string]paramValue{}
	for id := range given {
		if !slices.ContainsFunc(defs, func(d ParamDef) bool { return d.ID == id }) {
			return nil, invalid("params."+id, fmt.Sprintf("the report has no param %q", id))
		}
	}
	for _, d := range defs {
		raw, at := given[d.ID], "params."+d.ID
		if raw == nil {
			raw, at = d.Default, "params."+d.ID+".default"
		}
		v, err := parseParam(d, raw, pc, at)
		if err != nil {
			return nil, err
		}
		out[d.ID] = v
	}
	return out, nil
}

func parseParam(d ParamDef, raw json.RawMessage, pc periodContext, at string) (paramValue, *SpecError) {
	out := paramValue{typ: d.Type, multiple: d.Multiple}
	if raw == nil || string(bytes.TrimSpace(raw)) == "null" {
		out.unset = true
		return out, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return out, invalid(at, "the value is not valid JSON")
	}
	switch d.Type {
	case ParamDate, ParamAsOf:
		day, err := dayValue(v, d.Type, pc, at)
		if err != nil {
			return out, err
		}
		out.value = day
	case ParamDateRange:
		from, to, err := rangeValue(v, pc, at)
		if err != nil {
			return out, err
		}
		out.from, out.to = from, to
	case ParamText:
		s, ok := v.(string)
		if !ok || len(s) > maxParamText {
			return out, invalid(at, fmt.Sprintf("the value is text of at most %d characters", maxParamText))
		}
		out.value = s
	case ParamNumber:
		n, ok := v.(json.Number)
		if !ok {
			return out, invalid(at, "the value is a number")
		}
		out.value = numberValue(n)
	case ParamChoice:
		return choiceValue(d, v, at)
	}
	return out, nil
}

func choiceValue(d ParamDef, v any, at string) (paramValue, *SpecError) {
	out := paramValue{typ: d.Type, multiple: d.Multiple}
	valid := func(s string) bool {
		return slices.ContainsFunc(d.Options, func(o Option) bool { return o.Value == s })
	}
	if !d.Multiple {
		s, ok := v.(string)
		if !ok || !valid(s) {
			return out, invalid(at, "the value is one of the param's options")
		}
		out.value = s
		return out, nil
	}
	items, ok := v.([]any)
	if !ok {
		return out, invalid(at, "the value is a list of the param's options")
	}
	out.list = []string{}
	for _, item := range items {
		s, ok := item.(string)
		if !ok || !valid(s) {
			return out, invalid(at, "the value is a list of the param's options")
		}
		out.list = append(out.list, s)
	}
	return out, nil
}

func dayValue(v any, typ string, pc periodContext, at string) (string, *SpecError) {
	if s, ok := v.(string); ok {
		if !isDay(s) {
			return "", invalid(at, "a date is YYYY-MM-DD")
		}
		return s, nil
	}
	preset, ok := presetOf(v)
	presets := []string{"today"}
	if typ == ParamAsOf {
		presets = asOfPresets
	}
	if !ok || !slices.Contains(presets, preset) {
		return "", invalid(at, fmt.Sprintf("the value is a date or a preset of %v", presets))
	}
	return asOfDay(preset, pc), nil
}

func rangeValue(v any, pc periodContext, at string) (string, string, *SpecError) {
	if preset, ok := presetOf(v); ok {
		if !slices.Contains(rangePresets, preset) {
			return "", "", invalid(at, fmt.Sprintf("the preset is one of %v", rangePresets))
		}
		from, to := rangeDays(preset, pc)
		return from, to, nil
	}
	m, ok := v.(map[string]any)
	from, okFrom := m["from"].(string)
	to, okTo := m["to"].(string)
	if !ok || len(m) != 2 || !okFrom || !okTo || !isDay(from) || !isDay(to) {
		return "", "", invalid(at, `a date range is {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} or {"preset": …}`)
	}
	if from > to {
		return "", "", invalid(at, "from must be on or before to")
	}
	return from, to, nil
}

func presetOf(v any) (string, bool) {
	m, ok := v.(map[string]any)
	if !ok || len(m) != 1 {
		return "", false
	}
	p, ok := m["preset"].(string)
	return p, ok
}

// isDay is the shell's day rule: YYYY-MM-DD, a real day, year 1900 or later.
func isDay(s string) bool {
	day, err := time.Parse(time.DateOnly, s)
	return err == nil && day.Year() >= 1900
}

// Months are counted from year 0 (index = year*12 + month-1), as the shell's
// period presets count them.
func monthIndex(day time.Time) int { return day.Year()*12 + int(day.Month()) - 1 }

func firstDay(index int) string {
	return time.Date(index/12, time.Month(index%12+1), 1, 0, 0, 0, 0, time.UTC).Format(time.DateOnly)
}

func lastDay(index int) string {
	return time.Date(index/12, time.Month(index%12+1)+1, 0, 0, 0, 0, 0, time.UTC).Format(time.DateOnly)
}

// marks are the month indexes of today, its fiscal year's first month and
// its fiscal quarter's first month.
func marks(pc periodContext) (today, fyStart, quarterStart int) {
	today = monthIndex(pc.today)
	start := pc.fiscalStart
	if start < 1 || start > 12 {
		start = 1
	}
	year := pc.today.Year()
	if int(pc.today.Month()) < start {
		year--
	}
	fyStart = year*12 + start - 1
	quarterStart = fyStart + (today-fyStart)/3*3
	return today, fyStart, quarterStart
}

func rangeDays(preset string, pc periodContext) (string, string) {
	today, fy, q := marks(pc)
	day := pc.today.Format(time.DateOnly)
	switch preset {
	case "today":
		return day, day
	case "thisMonth":
		return firstDay(today), lastDay(today)
	case "thisMonthToDate":
		return firstDay(today), day
	case "thisQuarter":
		return firstDay(q), lastDay(q + 2)
	case "thisQuarterToDate":
		return firstDay(q), day
	case "thisFiscalYear":
		return firstDay(fy), lastDay(fy + 11)
	case "thisFiscalYearToDate":
		return firstDay(fy), day
	case "lastMonth":
		return firstDay(today - 1), lastDay(today - 1)
	case "lastQuarter":
		return firstDay(q - 3), lastDay(q - 1)
	case "lastFiscalYear":
		return firstDay(fy - 12), lastDay(fy - 1)
	}
	return firstDay(today - 12), lastDay(today - 1) // last12Months
}

func asOfDay(preset string, pc periodContext) string {
	today, fy, q := marks(pc)
	switch preset {
	case "endOfLastMonth":
		return lastDay(today - 1)
	case "endOfLastQuarter":
		return lastDay(q - 1)
	case "endOfLastFiscalYear":
		return lastDay(fy - 1)
	}
	return pc.today.Format(time.DateOnly)
}

// paramExpr is a resolved param as a formula leaf.
func paramExpr(c fctx, v paramValue) expr {
	switch v.typ {
	case ParamDateRange:
		if v.unset {
			return expr{rng: true, lo: "NULL", hi: "NULL", unset: true}
		}
		return expr{rng: true, lo: c.bind(v.from), hi: c.bind(v.to)}
	case ParamChoice:
		if v.multiple {
			parts := make([]any, len(v.list))
			for i, s := range v.list {
				parts[i] = s
			}
			return expr{sql: bindList(c, parts), typ: Text, list: true, unset: v.unset}
		}
	}
	typ := map[string]FieldType{ParamDate: Date, ParamAsOf: Date, ParamText: Text, ParamNumber: Number, ParamChoice: Text}[v.typ]
	if v.unset {
		return expr{sql: "NULL", typ: typ, unset: true}
	}
	return expr{sql: c.bind(v.value), typ: typ}
}

func bindList(c fctx, values []any) string {
	if len(values) == 0 {
		return "()"
	}
	out := "("
	for i, v := range values {
		if i > 0 {
			out += ", "
		}
		out += c.bind(v)
	}
	return out + ")"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/params.go \
  core/server/reports/params_test.go
git commit -m "feat(core): report params with the shell's period presets"
```

---

### Task 8: `Validate`: bind a spec to the registry

**Files:**
- Create: `$WS/tinycld/core/server/reports/bind.go`
- Test: `$WS/tinycld/core/server/reports/bind_test.go`

`bind` checks everything that does not need SQL: every path against the registry (links, cardinality, `mode`, `with`, depth, the fan-out error), aggregates against what each field offers, ids, sort, groups, the pivot, the layout's shape and the nest chain. It collects every problem; an unknown reference wins (422) so a broken report names everything that is missing. `p5-report-sharing` calls `Load` then `Validate` when it saves a report and in `reports validate`. Task 10 makes `Validate` also compile the spec.

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7.
- Produces:
  - `func Validate(spec *Spec) error` (nil, or a `*SpecError`).
  - `func bind(spec *Spec) (*plan, *SpecError)` and the bound types: `plan{spec, base, cols, byID, groups, pivot, sort, layout, nest}`, `hopPlan{link, from, to, mode, required}`, `pathPlan{hops, field, src}`, `colPlan{col, at, path, tm, nest, scale}` (`tm`: index of the to-many aggregate hop or -1; `nest`: nest level or 0), `groupPlan{group, col, at}`, `pivotPlan{pivot, path, cell, max}`, `sortPlan{col, desc}`, `nestLevel{hops, cols}`; `func hopsKey(hops []hopPlan) string`.
  - `type binder` with `bad`, `missing`, `err`, `merge`, `path(src, path, at, kind pathKind, agg Aggregate) *pathPlan`; `pathKind` values `pathColumn`, `pathValue`, `pathLinks`.
  - Limits: `maxColumns` 100, `maxHops` 4, `maxSort` 10, `maxGroups` 6, `maxLayoutItems` 200, `maxPivotColumns` 200, default pivot columns 50; buckets `day`, `month`, `quarter`, `year`, `fiscalYear`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/bind_test.go`:

```go
package reports

import (
	"encoding/json"
	"testing"
)

// loadSpec loads a spec and fails the test when it is not well-formed JSON.
func loadSpec(t *testing.T, raw string) *Spec {
	t.Helper()
	spec, _, err := Load([]byte(raw))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return spec
}

func TestValidateAcceptsTheDesignExample(t *testing.T) {
	withZooRegistry(t)
	if err := Validate(loadSpec(t, designExample)); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidateNamesEveryUnknownReference(t *testing.T) {
	withZooRegistry(t)
	RegisterSource(Source{
		Key: "zoo.pens", Collection: "zoo_pens", Label: "Pens",
		Links: []Link{{Key: "yard", Label: "Yard", Target: "zoo.yards", Cardinality: ToOne, Field: "yard"}},
	})
	cases := map[string]struct {
		spec, at, code string
	}{
		"source": {`{"version":1,"source":"zoo.gone","columns":[{"id":"a","path":[{"field":"name"}]}]}`, "source", "unknown_source"},
		"link": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"link":"pen"},{"field":"name"}]}]}`,
			"columns.0.path.0.link", "unknown_link"},
		"field": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"link":"animal"},{"field":"tail"}]}]}`,
			"columns.0.path.1.field", "unknown_field"},
		"link target": {`{"version":1,"source":"zoo.pens","columns":[{"id":"a","path":[{"link":"yard"},{"field":"name"}]}]}`,
			"columns.0.path.0.link", "unknown_source"},
		"sort column": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}]}],"sort":[{"col":"b"}]}`,
			"sort.0.col", "unknown_column"},
		"group column": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}]}],"groups":[{"id":"g","col":"b"}]}`,
			"groups.0.col", "unknown_column"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := Validate(loadSpec(t, c.spec))
			requireSpecError(t, err, 422, c.at, "")
			if code := err.(*SpecError).Problems[c.at].Code(); code != c.code {
				t.Fatalf("code = %q, want %q", code, c.code)
			}
		})
	}
}

func TestValidateRefusesAnInvalidSpec(t *testing.T) {
	withZooRegistry(t)
	cols := func(c string) string {
		return `{"version":1,"source":"zoo.feedings","columns":[` + c + `]}`
	}
	cases := map[string]struct {
		spec, at, want string
	}{
		"no columns":  {cols(``), "columns", "1 to 100 columns"},
		"bad id":      {cols(`{"id":"1a","path":[{"field":"cost"}]}`), "columns.0.id", "an id of letters"},
		"repeated id": {cols(`{"id":"a","path":[{"field":"cost"}]},{"id":"a","path":[{"field":"fed"}]}`), "columns.1.id", "used twice"},
		"path and formula": {cols(`{"id":"a","path":[{"field":"cost"}],"formula":{"value":1}}`), "columns.0",
			"a path or a formula"},
		"sum across to-many": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings"},{"field":"cost"}],"aggregate":"sum"}]}`,
			"columns.0.path.0", "a sum across a to-many link would double-count"},
		"to-many without mode": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings"},{"field":"cost"}]}]}`,
			"columns.0.path.0", "needs mode aggregate or nest"},
		"total without aggregate": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"aggregate"},{"field":"cost"}]}]}`,
			"columns.0.aggregate", "needs an aggregate"},
		"two to-many totals": {`{"version":1,"source":"zoo.sites","columns":[{"id":"a","path":[{"link":"animals","mode":"aggregate"},{"link":"feedings","mode":"aggregate"},{"field":"cost"}],"aggregate":"sum"}]}`,
			"columns.0.path.1", "a total crosses one to-many link"},
		"mode on to-one": {cols(`{"id":"a","path":[{"link":"animal","mode":"nest"},{"field":"name"}]}`), "columns.0.path.0",
			"mode is for a to-many link"},
		"too many links": {cols(`{"id":"a","path":[{"link":"animal"},{"link":"feedings","mode":"nest"},{"link":"animal"},{"link":"feedings","mode":"nest"},{"link":"animal"},{"field":"name"}]}`),
			"columns.0.path.4", "at most 4 links"},
		"field not last": {cols(`{"id":"a","path":[{"field":"cost"},{"link":"animal"}]}`), "columns.0.path.0", "the last step"},
		"no field":       {cols(`{"id":"a","path":[{"link":"animal"}]}`), "columns.0.path", "ends with a field"},
		"total of child rows": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"nest"},{"field":"cost"}],"aggregate":"sum"}]}`,
			"columns.0.aggregate", "child rows are not totalled"},
		"required nest": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"nest","with":"required"},{"field":"cost"}]}]}`,
			"columns.0.path.0", "with does not apply"},
		"two nest chains": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"nest"},{"field":"cost"}]},{"id":"b","path":[{"link":"keepers","mode":"nest"},{"link":"user"},{"field":"name"}]}]}`,
			"columns.1.path", "nests one chain of child rows"},
		"aggregate not offered": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"field":"species"}],"aggregate":"sum"}]}`,
			"columns.0.aggregate", "Species does not offer sum"},
		"distinct count across to-many": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"aggregate"},{"field":"id"}],"aggregate":"countDistinct"}]}`,
			"columns.0.aggregate", "cannot be totalled"},
		"to-many total of mixed currencies": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"link":"feedings","mode":"aggregate"},{"field":"cost"}],"aggregate":"sum"}]}`,
			"columns.0.aggregate", "different currencies"},
		"avg without scale": {cols(`{"id":"a","path":[{"field":"cost"}],"aggregate":"avg"}`), "columns.0.scale", "needs a scale"},
		"scale without avg": {cols(`{"id":"a","path":[{"field":"cost"}],"aggregate":"sum","scale":2}`), "columns.0.scale", "only an avg column"},
		"bucket of text": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"note"}]}],"groups":[{"id":"g","col":"a","bucket":"month"}]}`,
			"groups.0.bucket", "only a date column"},
		"pivot without groups": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}],"aggregate":"sum"}],"pivot":{"path":[{"field":"fed"}],"bucket":"month","cell":"a"}}`,
			"pivot", "needs at least one group"},
		"pivot cell without aggregate": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}]},{"id":"n","path":[{"field":"note"}]}],"groups":[{"id":"g","col":"n"}],"pivot":{"path":[{"field":"fed"}],"cell":"a"}}`,
			"pivot.cell", "a column with an aggregate"},
		"pivot across to-many": {`{"version":1,"source":"zoo.animals","columns":[{"id":"a","path":[{"field":"weight"}],"aggregate":"sum"},{"id":"n","path":[{"field":"name"}]}],"groups":[{"id":"g","col":"n"}],"pivot":{"path":[{"link":"feedings"},{"field":"fed"}],"cell":"a"}}`,
			"pivot.path.0", "reads a to-many link only through exists"},
		"layout without groups": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}],"aggregate":"sum"}],"layout":[{"section":"s","title":"S","key":"x"}]}`,
			"layout", "needs a group"},
		"layout item of both kinds": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"note"}]}],"groups":[{"id":"g","col":"a"}],"layout":[{"section":"s","row":"r","title":"S","key":"x"}]}`,
			"layout.0", "a section or a computed row"},
		"section without key": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"note"}]}],"groups":[{"id":"g","col":"a"}],"layout":[{"section":"s","title":"S"}]}`,
			"layout.0", "the key of a first-level group"},
		"version": {`{"version":2,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}]}]}`, "version", "load the spec first"},
		"param":   {`{"version":1,"source":"zoo.feedings","params":[{"id":"p","type":"color"}],"columns":[{"id":"a","path":[{"field":"cost"}]}]}`, "params.0.type", "unknown param type"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			// Decoded directly, not loaded: Load itself refuses a newer
			// version, and Validate must refuse a spec that skipped Load.
			var spec Spec
			if err := json.Unmarshal([]byte(c.spec), &spec); err != nil {
				t.Fatalf("decode: %v", err)
			}
			requireSpecError(t, Validate(&spec), 400, c.at, c.want)
		})
	}
}

func TestBindRecordsTheNestChain(t *testing.T) {
	withZooRegistry(t)
	spec := loadSpec(t, `{"version":1,"source":"zoo.sites","columns":[
		{"id":"site","path":[{"field":"name"}]},
		{"id":"animal","path":[{"link":"animals","mode":"nest"},{"field":"name"}]},
		{"id":"fed","path":[{"link":"animals","mode":"nest"},{"link":"feedings","mode":"nest"},{"field":"fed"}]},
		{"id":"owner","path":[{"link":"animals","mode":"nest"},{"link":"owner"},{"field":"name"}]}]}`)
	p, err := bind(spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.nest) != 2 {
		t.Fatalf("%d nest levels, want 2", len(p.nest))
	}
	ids := func(l *nestLevel) []string {
		var out []string
		for _, cp := range l.cols {
			out = append(out, cp.col.ID)
		}
		return out
	}
	if got := ids(p.nest[0]); len(got) != 2 || got[0] != "animal" || got[1] != "owner" {
		t.Fatalf("level 1 columns = %v", got)
	}
	if got := ids(p.nest[1]); len(got) != 1 || got[0] != "fed" {
		t.Fatalf("level 2 columns = %v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: Validate`, `undefined: bind`.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/bind.go`:

```go
package reports

import (
	"fmt"
	"slices"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

// Spec limits. A spec past one of them is refused before it is compiled.
const (
	maxColumns      = 100
	maxHops         = 4
	maxSort         = 10
	maxGroups       = 6
	maxLayoutItems  = 200
	maxLabel        = 200
	maxFormat       = 32
	maxPivotColumns = 200
	defaultPivotMax = 50
)

var buckets = []string{"day", "month", "quarter", "year", "fiscalYear"}

// plan is a spec bound to the registry: every path resolved to its links
// and field, every column reference to its column.
type plan struct {
	spec   *Spec
	base   *Source
	cols   []*colPlan
	byID   map[string]*colPlan
	groups []*groupPlan
	pivot  *pivotPlan
	sort   []sortPlan
	layout []*LayoutItem
	// nest is the chain of nested child rows, outermost first.
	nest []*nestLevel
}

type hopPlan struct {
	link     *Link
	from, to *Source
	mode     string // "", "aggregate" or "nest"
	required bool
}

type pathPlan struct {
	hops  []hopPlan
	field *Field
	src   *Source // the source the field is on
}

// key names a path's links; equal keys share one join.
func hopsKey(hops []hopPlan) string {
	parts := make([]string, len(hops))
	for i, h := range hops {
		parts[i] = h.link.Key
		if h.required {
			parts[i] += "!"
		}
	}
	return strings.Join(parts, "/")
}

type colPlan struct {
	col   *Column
	at    string
	path  *pathPlan // nil for a formula column
	tm    int       // index of the path's to-many aggregate hop, or -1
	nest  int       // nest level, 1 for the first; 0 when not nested
	scale int
}

type groupPlan struct {
	group *Group
	col   *colPlan
	at    string
}

type pivotPlan struct {
	pivot *Pivot
	path  *pathPlan
	cell  *colPlan
	max   int
}

type sortPlan struct {
	col  *colPlan
	desc bool
}

// nestLevel is one level of nested child rows: the hops from its parent's
// source through the nest link, and the columns it shows.
type nestLevel struct {
	hops []hopPlan // every hop from the base through this level's nest link
	cols []*colPlan
}

// binder collects every problem, so the builder can mark every bad part at
// once. Unknown references win: a report that names something missing
// opens in an error state that names it.
type binder struct {
	invalid map[string]validation.Error
	unknown map[string]validation.Error
}

func (b *binder) bad(at, message string) {
	if _, seen := b.invalid[at]; !seen {
		b.invalid[at] = validation.NewError("invalid", message)
	}
}

func (b *binder) missing(at, code, message string) {
	if _, seen := b.unknown[at]; !seen {
		b.unknown[at] = validation.NewError(code, message)
	}
}

func (b *binder) err() *SpecError {
	if len(b.unknown) > 0 {
		return &SpecError{Status: 422, Problems: b.unknown}
	}
	if len(b.invalid) > 0 {
		return &SpecError{Status: 400, Problems: b.invalid}
	}
	return nil
}

func (b *binder) merge(err *SpecError) {
	if err == nil {
		return
	}
	target := b.invalid
	if err.Status == 422 {
		target = b.unknown
	}
	for k, v := range err.Problems {
		if _, seen := target[k]; !seen {
			target[k] = v
		}
	}
}

// Validate checks a loaded spec against the registry without running it.
// It returns nil, or a *SpecError: 422 when the spec names a source, link,
// field or column that does not exist, else 400 listing what is invalid.
func Validate(spec *Spec) error {
	_, err := bind(spec)
	if err != nil {
		return err
	}
	return nil
}

func bind(spec *Spec) (*plan, *SpecError) {
	b := &binder{invalid: map[string]validation.Error{}, unknown: map[string]validation.Error{}}
	if spec.Version != CurrentVersion {
		b.bad("version", fmt.Sprintf("version must be %d; load the spec first", CurrentVersion))
	}
	base := lookupSource(spec.Source)
	if base == nil {
		b.missing("source", "unknown_source", fmt.Sprintf("the source %q does not exist", spec.Source))
		return nil, b.err()
	}
	p := &plan{spec: spec, base: base, byID: map[string]*colPlan{}}
	b.merge(checkParamDefs(spec.Params))
	b.columns(p)
	b.nestChain(p)
	b.sorts(p)
	b.groupsAndPivot(p)
	b.layout(p)
	if err := b.err(); err != nil {
		return nil, err
	}
	return p, nil
}

func (b *binder) columns(p *plan) {
	cols := p.spec.Columns
	if len(cols) == 0 || len(cols) > maxColumns {
		b.bad("columns", fmt.Sprintf("a report has 1 to %d columns", maxColumns))
	}
	for i := range cols {
		c := &cols[i]
		at := fmt.Sprintf("columns.%d", i)
		cp := &colPlan{col: c, at: at, tm: -1}
		switch {
		case !idRe.MatchString(c.ID):
			b.bad(at+".id", "a column needs an id of letters, digits and _")
		case p.byID[c.ID] != nil:
			b.bad(at+".id", fmt.Sprintf("the id %q is used twice", c.ID))
		default:
			p.byID[c.ID] = cp
		}
		if len(c.Label) > maxLabel || len(c.Format) > maxFormat {
			b.bad(at, fmt.Sprintf("a label has at most %d characters and a format %d", maxLabel, maxFormat))
		}
		if (c.Path == nil) == (c.Formula == nil) {
			b.bad(at, "a column has a path or a formula")
		}
		p.cols = append(p.cols, cp)
		if c.Path != nil {
			b.pathColumn(p, cp)
		} else if c.Formula != nil && c.Aggregate != "" {
			b.scaleOf(cp, c.Aggregate)
		}
	}
}

func (b *binder) pathColumn(p *plan, cp *colPlan) {
	c := cp.col
	path := b.path(p.base, c.Path, cp.at+".path", pathColumn, c.Aggregate)
	if path == nil {
		return
	}
	cp.path = path
	for i, h := range path.hops {
		switch h.mode {
		case "aggregate":
			cp.tm = i
		case "nest":
			cp.nest++
		}
	}
	at := cp.at + ".aggregate"
	switch {
	case c.Aggregate == "":
		if cp.tm >= 0 {
			b.bad(at, "a total across a to-many link needs an aggregate")
		}
	case cp.nest > 0:
		b.bad(at, "child rows are not totalled; add the link as a total instead")
	case !path.field.allows(c.Aggregate):
		b.bad(at, fmt.Sprintf("%s does not offer %s", path.field.Label, c.Aggregate))
	case cp.tm >= 0 && c.Aggregate == CountDistinct:
		b.bad(at, "a distinct count across a to-many link cannot be totalled; count the linked records")
	case cp.tm >= 0 && path.field.Currency != "":
		b.bad(at, "a total across a to-many link would add amounts of different currencies")
	default:
		b.scaleOf(cp, c.Aggregate)
	}
}

func (b *binder) scaleOf(cp *colPlan, agg Aggregate) {
	scale := cp.col.Scale
	if agg != Avg {
		if scale != nil {
			b.bad(cp.at+".scale", "only an avg column has a scale")
		}
		return
	}
	if scale == nil || *scale < 0 || *scale > MaxScale {
		b.bad(cp.at+".scale", fmt.Sprintf("an avg column needs a scale from 0 to %d", MaxScale))
		return
	}
	cp.scale = *scale
}

type pathKind int

const (
	pathColumn pathKind = iota // a column: to-many hops need a mode
	pathValue                  // a filter, formula or pivot value: to-one only
	pathLinks                  // an exists link: links only, to-many allowed
)

// path binds a path to the registry. It returns nil when the path is broken,
// after recording why.
func (b *binder) path(src *Source, path Path, at string, kind pathKind, agg Aggregate) *pathPlan {
	if len(path) == 0 {
		b.bad(at, "a path has at least one step")
		return nil
	}
	out := &pathPlan{}
	links, modes := 0, map[string]bool{}
	for j, hop := range path {
		hat := fmt.Sprintf("%s.%d", at, j)
		last := j == len(path)-1
		if (hop.Link == "") == (hop.Field == "") {
			b.bad(hat, "a step is a link or a field")
			return nil
		}
		if hop.Field != "" {
			if !last || kind == pathLinks {
				b.bad(hat, "a field is the last step of a path; an exists path has links only")
				return nil
			}
			out.field, out.src = src.field(hop.Field), src
			if out.field == nil {
				b.missing(hat+".field", "unknown_field", fmt.Sprintf("the source %q has no field %q", src.Key, hop.Field))
				return nil
			}
			if hop.Mode != "" || hop.With != "" {
				b.bad(hat, "mode and with belong to a link step")
				return nil
			}
			return out
		}
		links++
		if links > maxHops {
			b.bad(hat, fmt.Sprintf("a path follows at most %d links", maxHops))
			return nil
		}
		link := src.link(hop.Link)
		if link == nil {
			b.missing(hat+".link", "unknown_link", fmt.Sprintf("the source %q has no link %q", src.Key, hop.Link))
			return nil
		}
		target := lookupSource(link.Target)
		if target == nil {
			b.missing(hat+".link", "unknown_source", fmt.Sprintf("the link %q leads to the source %q, which does not exist", hop.Link, link.Target))
			return nil
		}
		if hop.With != "" && hop.With != "required" && hop.With != "optional" {
			b.bad(hat+".with", "with is required or optional")
			return nil
		}
		h := hopPlan{link: link, from: src, to: target, mode: hop.Mode, required: hop.With == "required"}
		if msg := hopProblem(h, kind, agg, modes); msg != "" {
			b.bad(hat, msg)
			return nil
		}
		if h.mode != "" {
			modes[h.mode] = true
		}
		out.hops = append(out.hops, h)
		src = target
	}
	if kind != pathLinks {
		b.bad(at, "a path ends with a field")
		return nil
	}
	out.src = src
	return out
}

func hopProblem(h hopPlan, kind pathKind, agg Aggregate, seen map[string]bool) string {
	toMany := h.link.Cardinality == ToMany
	switch {
	case h.mode != "" && kind != pathColumn:
		return "mode belongs to a column's to-many link"
	case h.mode != "" && !toMany:
		return "mode is for a to-many link"
	case h.mode != "" && h.mode != "aggregate" && h.mode != "nest":
		return "mode is aggregate or nest"
	case h.mode == "nest" && h.required:
		return "child rows show the linked rows there are; with does not apply"
	case !toMany:
		return ""
	case kind == pathValue:
		return "a value reads a to-many link only through exists or a total column"
	case kind == pathLinks:
		return ""
	case h.mode == "" && agg != "":
		return fmt.Sprintf("a %s across a to-many link would double-count: add the link as a total (mode aggregate)", agg)
	case h.mode == "":
		return "a to-many link needs mode aggregate or nest"
	case seen["aggregate"]:
		return "a total crosses one to-many link"
	case h.mode == "aggregate" && seen["nest"], h.mode == "nest" && seen["aggregate"]:
		return "a path either totals or nests a to-many link, not both"
	}
	return ""
}

// nestChain checks that every nested column lies on one chain of nest
// links, and records the chain.
func (b *binder) nestChain(p *plan) {
	var longest []hopPlan
	var longestCol *colPlan
	for _, cp := range p.cols {
		if cp.nest == 0 || cp.path == nil {
			continue
		}
		prefix := nestPrefix(cp.path.hops)
		short, long := prefix, longest
		if len(short) > len(long) {
			short, long = long, short
		}
		if hopsKey(long[:len(short)]) != hopsKey(short) || !sameNests(long[:len(short)], short) {
			b.bad(cp.at+".path", fmt.Sprintf("a report nests one chain of child rows; this column leaves the chain of %q", longestCol.col.ID))
			continue
		}
		if len(prefix) > len(longest) {
			longest, longestCol = prefix, cp
		}
	}
	for i, h := range longest {
		if h.mode == "nest" {
			p.nest = append(p.nest, &nestLevel{hops: longest[:i+1]})
		}
	}
	for _, cp := range p.cols {
		if cp.nest > 0 && cp.nest <= len(p.nest) {
			p.nest[cp.nest-1].cols = append(p.nest[cp.nest-1].cols, cp)
		}
	}
}

// nestPrefix is the hops up to and including the last nest hop.
func nestPrefix(hops []hopPlan) []hopPlan {
	last := -1
	for i, h := range hops {
		if h.mode == "nest" {
			last = i
		}
	}
	return hops[:last+1]
}

func sameNests(a, b []hopPlan) bool {
	for i := range a {
		if a[i].mode != b[i].mode {
			return false
		}
	}
	return true
}

func (b *binder) column(p *plan, id, at string) *colPlan {
	cp := p.byID[id]
	if cp == nil {
		b.missing(at, "unknown_column", fmt.Sprintf("the report has no column %q", id))
	}
	return cp
}

func (b *binder) sorts(p *plan) {
	if len(p.spec.Sort) > maxSort {
		b.bad("sort", fmt.Sprintf("a report sorts by at most %d columns", maxSort))
	}
	for i, s := range p.spec.Sort {
		at := fmt.Sprintf("sort.%d", i)
		cp := b.column(p, s.Col, at+".col")
		if s.Dir != "" && s.Dir != "asc" && s.Dir != "desc" {
			b.bad(at+".dir", "dir is asc or desc")
		}
		if cp == nil {
			continue
		}
		if cp.nest > 0 {
			b.bad(at+".col", "child rows keep their own order")
			continue
		}
		p.sort = append(p.sort, sortPlan{col: cp, desc: s.Dir == "desc"})
	}
}

func (b *binder) groupsAndPivot(p *plan) {
	spec := p.spec
	if len(spec.Groups) > maxGroups {
		b.bad("groups", fmt.Sprintf("a report has at most %d group levels", maxGroups))
	}
	seen := map[string]bool{}
	for i := range spec.Groups {
		g := &spec.Groups[i]
		at := fmt.Sprintf("groups.%d", i)
		if !idRe.MatchString(g.ID) || seen[g.ID] {
			b.bad(at+".id", "a group needs a unique id of letters, digits and _")
		}
		seen[g.ID] = true
		cp := b.column(p, g.Col, at+".col")
		if cp == nil {
			continue
		}
		if cp.nest > 0 {
			b.bad(at+".col", "a report does not group by child rows")
			continue
		}
		if g.Bucket != "" {
			if !slices.Contains(buckets, g.Bucket) {
				b.bad(at+".bucket", fmt.Sprintf("bucket is one of %v", buckets))
			} else if cp.path != nil && cp.path.field.Type != Date && cp.path.field.Type != DateTime {
				b.bad(at+".bucket", "only a date column has a bucket")
			}
		}
		p.groups = append(p.groups, &groupPlan{group: g, col: cp, at: at})
	}
	pv := spec.Pivot
	if pv == nil {
		return
	}
	if len(spec.Groups) == 0 {
		b.bad("pivot", "a pivot needs at least one group")
	}
	pp := &pivotPlan{pivot: pv, max: pv.MaxColumns}
	if pp.max == 0 {
		pp.max = defaultPivotMax
	}
	if pp.max < 1 || pp.max > maxPivotColumns {
		b.bad("pivot.maxColumns", fmt.Sprintf("maxColumns is 1 to %d", maxPivotColumns))
	}
	pp.path = b.path(p.base, pv.Path, "pivot.path", pathValue, "")
	if pp.path != nil && pv.Bucket != "" {
		if !slices.Contains(buckets, pv.Bucket) {
			b.bad("pivot.bucket", fmt.Sprintf("bucket is one of %v", buckets))
		} else if t := pp.path.field.Type; t != Date && t != DateTime {
			b.bad("pivot.bucket", "only a date has a bucket")
		}
	}
	pp.cell = b.column(p, pv.Cell, "pivot.cell")
	if pp.cell != nil && (pp.cell.col.Aggregate == "" || pp.cell.tm >= 0) {
		b.bad("pivot.cell", "the pivot cell is a column with an aggregate, not a total across a to-many link")
	}
	p.pivot = pp
}

func (b *binder) layout(p *plan) {
	items := p.spec.Layout
	if len(items) == 0 {
		return
	}
	if len(items) > maxLayoutItems {
		b.bad("layout", fmt.Sprintf("a layout has at most %d items", maxLayoutItems))
	}
	if len(p.spec.Groups) == 0 {
		b.bad("layout", "a layout selects rows by the first group, so it needs a group")
	}
	seen := map[string]bool{}
	for i := range items {
		item := &items[i]
		at := fmt.Sprintf("layout.%d", i)
		id, isSection := item.Section, item.Section != ""
		if !isSection {
			id = item.Row
		}
		switch {
		case isSection == (item.Row != ""):
			b.bad(at, "a layout item is a section or a computed row")
			continue
		case !idRe.MatchString(id) || seen[id]:
			b.bad(at, "a layout item needs a unique id of letters, digits and _")
		case isSection && (item.Key == nil || item.Formula != nil || item.Label != ""):
			b.bad(at, "a section has a title and the key of a first-level group")
		case !isSection && (item.Formula == nil || item.Key != nil || item.Title != ""):
			b.bad(at, "a computed row has a label and a formula")
		case len(item.Title) > maxLabel || len(item.Label) > maxLabel:
			b.bad(at, fmt.Sprintf("a title or label has at most %d characters", maxLabel))
		}
		seen[id] = true
		p.layout = append(p.layout, item)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/bind.go \
  core/server/reports/bind_test.go
git commit -m "feat(core): validate a report spec against the source registry"
```

---

### Task 9: The rows CTE: rule CTEs, joins, the filter, `exists` and to-many totals

**Files:**
- Create: `$WS/tinycld/core/server/reports/stmt.go` (statement, scopes, joins, to-many subqueries, exists, `scanRows`)
- Create: `$WS/tinycld/core/server/reports/rows.go` (the compiler and the CTE `w`)
- Create: `$WS/tinycld/core/server/reports/join.go` (the formula context inside `w`)
- Test: `$WS/tinycld/core/server/reports/rows_test.go`

`w` holds one row per base row the reader may list that passes the filter. Every reference to a collection, in `w`, in a to-many subquery and in an `exists`, reads that collection's rule CTE. Values are always bound (`rp<n>` placeholders), never written into the SQL; identifiers come from the registry only.

**Interfaces:**
- Consumes: `ruleSelect` (Task 4); `compileFormula`, `fctx`, `aggregateSQL`, `aggregateType` (Task 6); `paramExpr`, `paramValue` (Task 7); `plan`, `hopPlan`, `pathPlan`, `colPlan`, `binder`, `pathKind` (Task 8).
- Produces:
  - `stmt`: `newStmt(app core.App, info *core.RequestInfo) *stmt` (nil app = dry), `(*stmt).bind(v any) string`, `alias(prefix) string`, `rule(collection) string` (the CTE name `r<n>`), `with(ctes ...string) (string, error)`.
  - `q(alias, column) string`, `fieldSQL(alias string, f *Field) string` (a blank date, datetime, select or relation is NULL; a date is its `YYYY-MM-DD`).
  - `scope`: `newScope(s, src)`, `join(hops) string`, `value(p *pathPlan) expr`, `render() string`, `total(p, at int, op, scale) string`, `parentID(p, at int) string`, `exists(prefix, link *pathPlan, where *Node, mk func(*scope, []hopPlan) fctx, at string) (expr, error)`; `compileWhere`.
  - `scanRows(rows *dbx.Rows) ([]map[string]any, error)`.
  - `compiler{p, app, info, params, fiscal, currencies, currencyOf, detailTypes, levelTypes}`, `newCompiler(p, app, info, params) *compiler` (nil params = every param unset), `fiscalStartOf(src, app) int`, `(*compiler).rows(s *stmt) (*rowsCTE, error)`.
  - `rowsCTE`: `add(name, sql) string` (returns `w.<name>`), `colValue(cp) expr` (`w.c<idx>`), `inner(ref) string`, `hidden(p) string` (`w.h<n>`), `rowValue(cp, at, visiting) (expr, error)`, `join(filter bool) *joinCtx`, `render() string`; `bucketSQL(c fctx, bucket, day string) string`; `(*plan).index(cp) int`.
  - `join.go`: `bindValuePath`, `paramOf`, `unknownColumn`, `enter` (formula cycle guard), `joinCtx` (implements `fctx`).
  - Names inside `w`: `__id`, `k<g>` group keys, `ck<n>` currency keys, `c<idx>` path columns, `p<idx>`/`cs<idx>`/`cn<idx>` for to-many totals, `h<n>` hidden paths. Task 12 adds `pk`, Task 14 `n0`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/rows_test.go`:

```go
package reports

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// wRows compiles a spec's w for user and returns its rows: __id and each
// path column's value, keyed by column id, sorted by the first column.
func (z *zoo) wRows(t *testing.T, user, raw string, params map[string]string) ([]map[string]any, error) {
	t.Helper()
	spec, _, err := Load([]byte(raw))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	p, specErr := bind(spec)
	if specErr != nil {
		return nil, specErr
	}
	given := map[string]json.RawMessage{}
	for k, v := range params {
		given[k] = json.RawMessage(v)
	}
	values, specErr := resolveParams(spec.Params, given, periodContext{today: time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC), fiscalStart: 1})
	if specErr != nil {
		return nil, specErr
	}
	c := newCompiler(p, z.app, z.as(user), values)
	s := newStmt(z.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	sel := []string{"__id"}
	for idx, cp := range p.cols {
		if cp.path != nil && cp.nest == 0 {
			sel = append(sel, fmt.Sprintf("c%d AS %s", idx, cp.col.ID))
		}
	}
	with, err := s.with(r.render())
	if err != nil {
		return nil, err
	}
	rows, err := z.app.DB().NewQuery(with + "SELECT " + strings.Join(sel, ", ") + " FROM w").Bind(s.params).Rows()
	if err != nil {
		return nil, err
	}
	out, err := scanRows(rows)
	if err != nil {
		return nil, err
	}
	first := p.cols[0].col.ID
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i][first]) < fmt.Sprint(out[j][first]) })
	return out, nil
}

// column lists one column of rows.
func column(rows []map[string]any, id string) []any {
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r[id]
	}
	return out
}

func (z *zoo) mustW(t *testing.T, user, raw string, params map[string]string) []map[string]any {
	t.Helper()
	rows, err := z.wRows(t, user, raw, params)
	if err != nil {
		t.Fatalf("w: %v", err)
	}
	return rows
}

func TestWHoldsOnlyRowsTheReaderMayList(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.feedings","columns":[{"id":"note","path":[{"field":"note"}]}]}`
	if got := column(z.mustW(t, "ann", spec, nil), "note"); !reflect.DeepEqual(got, []any{"f1", "f2", "f3", "f4"}) {
		t.Fatalf("ann's feedings = %v", got)
	}
	if got := column(z.mustW(t, "bob", spec, nil), "note"); !reflect.DeepEqual(got, []any{"f3", "f4", "f5"}) {
		t.Fatalf("bob's feedings = %v", got)
	}
}

func TestAHiddenLinkedRowLeavesEmptyCellsAndKeepsTheRow(t *testing.T) {
	z := newZoo(t)
	// Bob keeps zed, owned by... bob; zed's site is south. The vault is
	// superuser-only, so its link is always hidden.
	rows := z.mustW(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}]},
		{"id":"owner","path":[{"link":"owner"},{"field":"name"}]},
		{"id":"site","path":[{"link":"site"},{"field":"name"}]}]}`, nil)
	if got := column(rows, "name"); !reflect.DeepEqual(got, []any{"Kit", "Leo", "Zed"}) {
		t.Fatalf("names = %v", got)
	}
	// Kit has no site: a blank relation is an empty cell too.
	if got := column(rows, "site"); !reflect.DeepEqual(got, []any{nil, "North", "South"}) {
		t.Fatalf("sites = %v", got)
	}
	// Members may list other members (core's users rule), so owners show.
	if got := column(rows, "owner"); !reflect.DeepEqual(got, []any{"ann", "ann", "bob"}) {
		t.Fatalf("owners = %v", got)
	}
	vault := z.mustW(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}]},
		{"id":"gold","path":[{"link":"feedings","mode":"aggregate"},{"field":"grams"}],"aggregate":"sum"}]}`, nil)
	if len(vault) != 3 {
		t.Fatalf("rows = %v", vault)
	}
}

func TestRequiredLinkDropsRowsWithoutIt(t *testing.T) {
	z := newZoo(t)
	rows := z.mustW(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}]},
		{"id":"site","path":[{"link":"site","with":"required"},{"field":"name"}]}]}`, nil)
	if got := column(rows, "name"); !reflect.DeepEqual(got, []any{"Leo", "Zed"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestAToManyTotalCountsOnlyVisibleLinkedRows(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}]},
		{"id":"fed","path":[{"link":"feedings","mode":"aggregate"},{"field":"id"}],"aggregate":"count"},
		{"id":"cost","path":[{"link":"feedings","mode":"aggregate"},{"field":"grams"}],"aggregate":"sum"},
		{"id":"last","path":[{"link":"feedings","mode":"aggregate"},{"field":"fed"}],"aggregate":"max"}]}`
	rows := z.mustW(t, "ann", spec, nil)
	// Ann sees kit but keeps no feeding of kit: f6 is hidden from her.
	want := map[string][]any{
		"name": {"Kit", "Leo", "Zed"},
		"fed":  {int64(0), int64(2), int64(2)},
		"cost": {int64(0), int64(1300), int64(400)},
		"last": {nil, "2026-02-10", "2026-03-03"},
	}
	for id, w := range want {
		if got := column(rows, id); !reflect.DeepEqual(got, w) {
			t.Errorf("%s = %#v, want %#v", id, got, w)
		}
	}
}

func TestFilterExistsAndNotExists(t *testing.T) {
	z := newZoo(t)
	base := `{"version":1,"source":"zoo.sites","columns":[{"id":"name","path":[{"field":"name"}]}],"filter":%s}`
	cases := map[string]struct {
		filter string
		want   []any
	}{
		"has an animal that is a zebra": {`{"op":"exists","link":[{"link":"animals"}],"where":{"op":"eq","args":[{"path":[{"field":"species"}]},{"value":"zebra"}]}}`, []any{"South"}},
		"has no visible animal":         {`{"op":"notExists","link":[{"link":"animals"}]}`, []any{}},
		"has a fed animal": {`{"op":"exists","link":[{"link":"animals"},{"link":"feedings"}],
			"where":{"op":"gt","args":[{"path":[{"field":"grams"}]},{"value":400}]}}`, []any{"North"}},
		"or of exists": {`{"op":"or","args":[{"op":"exists","link":[{"link":"animals"}],"where":{"op":"eq","args":[{"path":[{"field":"name"}]},{"value":"Zed"}]}},
			{"op":"eq","args":[{"path":[{"field":"region"}]},{"value":"north"}]}]}`, []any{"North", "South"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			rows := z.mustW(t, "ann", fmt.Sprintf(base, c.filter), nil)
			got := column(rows, "name")
			if len(got) == 0 {
				got = []any{}
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("sites = %v, want %v", got, c.want)
			}
		})
	}
}

func TestExistsLinkRowsTheReaderCannotSeeDoNotMatch(t *testing.T) {
	z := newZoo(t)
	// Mo lives in the north, but ann cannot list mo.
	rows := z.mustW(t, "ann", `{"version":1,"source":"zoo.sites","columns":[{"id":"name","path":[{"field":"name"}]}],
		"filter":{"op":"exists","link":[{"link":"animals"}],"where":{"op":"eq","args":[{"path":[{"field":"name"}]},{"value":"Mo"}]}}}`, nil)
	if len(rows) != 0 {
		t.Fatalf("rows = %v", rows)
	}
}

func TestAFilterOnAnUnsetParamMatchesEveryRow(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.feedings",
		"params":[{"id":"species","type":"text"},{"id":"period","type":"dateRange"}],
		"columns":[{"id":"note","path":[{"field":"note"}]}],
		"filter":{"op":"and","args":[
			{"op":"eq","args":[{"path":[{"link":"animal"},{"field":"species"}]},{"param":"species"}]},
			{"op":"between","args":[{"path":[{"field":"fed"}]},{"param":"period"}]}]}}`
	if got := column(z.mustW(t, "ann", spec, nil), "note"); len(got) != 4 {
		t.Fatalf("unset params: %v", got)
	}
	got := column(z.mustW(t, "ann", spec, map[string]string{"species": `"lion"`, "period": `{"from":"2026-02-01","to":"2026-02-28"}`}), "note")
	if !reflect.DeepEqual(got, []any{"f2"}) {
		t.Fatalf("set params: %v", got)
	}
}

func TestAFilterReadsAFormulaColumnAndAToManyTotal(t *testing.T) {
	z := newZoo(t)
	rows := z.mustW(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}]},
		{"id":"fed","path":[{"link":"feedings","mode":"aggregate"},{"field":"id"}],"aggregate":"count"},
		{"id":"heavy","formula":{"op":"gt","args":[{"path":[{"field":"weight"}]},{"value":100}]}}],
		"filter":{"op":"and","args":[{"col":"heavy"},{"op":"gt","args":[{"col":"fed"},{"value":0}]}]}}`, nil)
	if got := column(rows, "name"); !reflect.DeepEqual(got, []any{"Leo", "Zed"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestRowCompileErrors(t *testing.T) {
	z := newZoo(t)
	cases := map[string]struct {
		spec, at, want string
		status         int
	}{
		"to-many value in a filter": {`{"version":1,"source":"zoo.animals","columns":[{"id":"n","path":[{"field":"name"}]}],
			"filter":{"op":"gt","args":[{"path":[{"link":"feedings"},{"field":"grams"}]},{"value":1}]}}`,
			"filter.args.0.path.0", "reads a to-many link only through exists", 400},
		"total in a filter": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"n","path":[{"field":"note"}]}],
			"filter":{"op":"gt","args":[{"op":"sum","args":[{"path":[{"field":"cost"}]}]},{"value":1}]}}`,
			"filter.args.0", "use it in a column, not in a filter", 400},
		"filter not a condition": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"n","path":[{"field":"note"}]}],
			"filter":{"path":[{"field":"cost"}]}}`, "filter", "the filter is a condition", 400},
		"unknown param": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"n","path":[{"field":"note"}]}],
			"filter":{"op":"eq","args":[{"path":[{"field":"note"}]},{"param":"who"}]}}`, "filter.args.1", "no param", 422},
		"formula reads itself": {`{"version":1,"source":"zoo.feedings","columns":[{"id":"n","path":[{"field":"note"}]},
			{"id":"a","formula":{"op":"add","args":[{"col":"b"},{"value":1}]}},{"id":"b","formula":{"op":"add","args":[{"col":"a"},{"value":1}]}}],
			"filter":{"op":"gt","args":[{"col":"a"},{"value":1}]}}`, "columns.2.formula.args.0", "reads itself", 400},
		"where reads a column": {`{"version":1,"source":"zoo.sites","columns":[{"id":"n","path":[{"field":"name"}]}],
			"filter":{"op":"exists","link":[{"link":"animals"}],"where":{"op":"eq","args":[{"col":"n"},{"value":"x"}]}}}`,
			"filter.where.args.0", "not report columns", 400},
		"unknown exists link": {`{"version":1,"source":"zoo.sites","columns":[{"id":"n","path":[{"field":"name"}]}],
			"filter":{"op":"exists","link":[{"link":"pens"}]}}`, "filter.link.0.link", "no link", 422},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := z.wRows(t, "ann", c.spec, nil)
			requireSpecError(t, err, c.status, c.at, c.want)
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: newCompiler`, `undefined: newStmt`, `undefined: scanRows`.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/stmt.go`:

```go
package reports

import (
	"fmt"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// stmt is one SQL statement being built: its bound parameters, the rule
// CTE of every collection it reads, and unique aliases. With a nil app it
// is dry: Validate compiles a spec on one to check it, and nothing runs.
type stmt struct {
	app    core.App
	info   *core.RequestInfo
	params dbx.Params
	rules  []string // collections, in first-use order
	ruleOf map[string]string
	n      int
}

func newStmt(app core.App, info *core.RequestInfo) *stmt {
	return &stmt{app: app, info: info, params: dbx.Params{}, ruleOf: map[string]string{}}
}

// bind adds a value to the statement's parameters and returns its
// placeholder. Values are always bound, never written into the SQL.
func (s *stmt) bind(v any) string {
	name := fmt.Sprintf("rp%d", len(s.params))
	s.params[name] = v
	return "{:" + name + "}"
}

func (s *stmt) alias(prefix string) string {
	s.n++
	return fmt.Sprintf("%s%d", prefix, s.n)
}

// rule names the CTE that holds the rows of collection the reader may list.
// Every reference to the collection reads it, never the table.
func (s *stmt) rule(collection string) string {
	if name, ok := s.ruleOf[collection]; ok {
		return name
	}
	name := fmt.Sprintf("r%d", len(s.rules))
	s.ruleOf[collection] = name
	s.rules = append(s.rules, collection)
	return name
}

// with renders the rule CTEs, then the given CTEs, as one WITH clause.
func (s *stmt) with(ctes ...string) (string, error) {
	parts := make([]string, 0, len(s.rules)+len(ctes))
	for _, name := range s.rules {
		sql := "SELECT 1 AS id WHERE 0"
		if s.app != nil {
			col, err := s.app.FindCachedCollectionByNameOrId(name)
			if err != nil {
				return "", fmt.Errorf("reports: collection %q: %w", name, err)
			}
			ruleSQL, params, err := ruleSelect(s.app, col, s.info)
			if err != nil {
				return "", err
			}
			for k, v := range params {
				s.params[k] = v
			}
			sql = ruleSQL
		}
		parts = append(parts, s.ruleOf[name]+" AS ("+sql+")")
	}
	parts = append(parts, ctes...)
	if len(parts) == 0 {
		return "", nil
	}
	return "WITH " + strings.Join(parts, ",\n") + "\n", nil
}

func q(alias, column string) string { return "[[" + alias + "." + column + "]]" }

// fieldSQL reads a field from an alias. A blank date, select or relation is
// NULL, so a blank and a hidden linked row read the same.
func fieldSQL(alias string, f *Field) string {
	c := q(alias, f.Column)
	switch f.Type {
	case Date:
		return "NULLIF(substr(" + c + ", 1, 10), '')"
	case DateTime, Select, Relation:
		return "NULLIF(" + c + ", '')"
	}
	return c
}

// scope is a FROM clause and its joins: the rows of a statement, a to-many
// subquery or an exists subquery. Paths that share a prefix share a join.
type scope struct {
	s     *stmt
	src   *Source
	from  string // "r0 t1"
	alias string
	joins map[string]string
	sql   []string
	tms   []*tmSub
}

func newScope(s *stmt, src *Source) *scope {
	alias := s.alias("t")
	return &scope{
		s: s, src: src, alias: alias,
		from:  s.rule(src.Collection) + " " + alias,
		joins: map[string]string{},
	}
}

// join follows to-one hops from the scope's base and returns the alias of
// the last. A to-one link left-joins (inner with with: required): a linked
// row the reader cannot see leaves empty cells and keeps the row.
func (sc *scope) join(hops []hopPlan) string {
	alias := sc.alias
	for i := range hops {
		key := hopsKey(hops[:i+1])
		if next, ok := sc.joins[key]; ok {
			alias = next
			continue
		}
		h := hops[i]
		next := sc.s.alias("t")
		kind := "LEFT JOIN"
		if h.required {
			kind = "JOIN"
		}
		sc.sql = append(sc.sql, fmt.Sprintf("%s %s %s ON %s = %s",
			kind, sc.s.rule(h.to.Collection), next, q(next, "id"), q(alias, h.link.Field)))
		sc.joins[key] = next
		alias = next
	}
	return alias
}

// value reads a to-one path's field in this scope.
func (sc *scope) value(p *pathPlan) expr {
	return expr{sql: fieldSQL(sc.join(p.hops), p.field), typ: p.field.Type}
}

// sql renders the FROM clause, its joins and its to-many subqueries.
func (sc *scope) render() string {
	parts := append([]string{"FROM " + sc.from}, sc.sql...)
	for _, tm := range sc.tms {
		parts = append(parts, tm.render())
	}
	return strings.Join(parts, "\n")
}

// tmSub is one to-many path totalled per parent row: a subquery grouped by
// the back relation, joined onto the parent. Every column that totals the
// same to-many path reads one subquery.
type tmSub struct {
	key      string
	parent   string // the parent row's alias in the outer scope
	required bool
	alias    string
	child    *scope
	back     string
	values   []string
}

// total adds a per-parent aggregate to the subquery of a column's to-many
// path and returns the SQL that reads it on the parent row.
func (sc *scope) total(p *pathPlan, at int, op Aggregate, scale int) string {
	prefix := p.hops[:at+1]
	key := hopsKey(prefix)
	i := slices.IndexFunc(sc.tms, func(t *tmSub) bool { return t.key == key })
	if i < 0 {
		h := prefix[at]
		tm := &tmSub{
			key: key, parent: sc.join(prefix[:at]), required: h.required,
			alias: sc.s.alias("m"), child: newScope(sc.s, h.to), back: h.link.BackField,
		}
		sc.tms = append(sc.tms, tm)
		i = len(sc.tms) - 1
	}
	tm := sc.tms[i]
	value := tm.child.value(&pathPlan{hops: p.hops[at+1:], field: p.field})
	name := fmt.Sprintf("v%d", len(tm.values))
	tm.values = append(tm.values, aggregateSQL(op, value.sql, scale)+" AS "+name)
	return q(tm.alias, name)
}

// parentID is the parent row's id the subquery of a to-many path joins on;
// group rows total a to-many column once per parent.
func (sc *scope) parentID(p *pathPlan, at int) string {
	return q(sc.join(p.hops[:at]), "id")
}

func (tm *tmSub) render() string {
	kind := "LEFT JOIN"
	if tm.required {
		kind = "JOIN"
	}
	back := q(tm.child.alias, tm.back)
	return fmt.Sprintf("%s (SELECT %s AS pk, %s\n%s\nGROUP BY %s) %s ON %s = %s",
		kind, back, strings.Join(tm.values, ", "), tm.child.render(), back, tm.alias, q(tm.alias, "pk"), q(tm.parent, "id"))
}

// exists compiles exists over a link path from the scope's base (after
// prefix): to-one hops join in this scope, and the first to-many hop opens a
// semi-join, so a match never multiplies the row.
func (sc *scope) exists(prefix []hopPlan, link *pathPlan, where *Node, mk func(*scope, []hopPlan) fctx, at string) (expr, error) {
	hops := append(slices.Clone(prefix), link.hops...)
	i := slices.IndexFunc(hops, func(h hopPlan) bool { return h.link.Cardinality == ToMany })
	if i < 0 {
		cond := q(sc.join(hops), "id") + " IS NOT NULL"
		if where != nil {
			w, err := compileWhere(mk(sc, hops), where, at)
			if err != nil {
				return expr{}, err
			}
			cond += " AND " + w.sql
		}
		return expr{sql: "(" + cond + ")", typ: Bool}, nil
	}
	parent := sc.join(hops[:i])
	child := newScope(sc.s, hops[i].to)
	rest := &pathPlan{hops: hops[i+1:]}
	inner, err := child.exists(nil, rest, where, mk, at)
	if err != nil {
		return expr{}, err
	}
	return expr{sql: fmt.Sprintf("EXISTS (SELECT 1\n%s\nWHERE %s = %s AND %s)",
		child.render(), q(child.alias, hops[i].link.BackField), q(parent, "id"), inner.sql), typ: Bool}, nil
}

func compileWhere(c fctx, where *Node, at string) (expr, error) {
	e, err := compileFormula(c, where, at+".where")
	if err != nil {
		return expr{}, err
	}
	if e.typ != Bool {
		return expr{}, invalid(at+".where", "where is a condition")
	}
	return e, nil
}

// scanRows reads every row as column name to value, keeping SQLite's types
// (int64, float64, string, nil). It closes rows.
func scanRows(rows *dbx.Rows) ([]map[string]any, error) {
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for rows.Next() {
		values := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(names))
		for i, name := range names {
			if b, ok := values[i].([]byte); ok {
				values[i] = string(b)
			}
			row[name] = values[i]
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
```

`$WS/tinycld/core/server/reports/join.go`:

```go
package reports

import (
	"fmt"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

// bindValuePath binds a filter's or formula's path: to-one links, then a
// field.
func bindValuePath(src *Source, path Path, at string, kind pathKind) (*pathPlan, error) {
	b := &binder{invalid: map[string]validation.Error{}, unknown: map[string]validation.Error{}}
	p := b.path(src, path, at, kind, "")
	if err := b.err(); err != nil {
		return nil, err
	}
	return p, nil
}

func paramOf(c *compiler, id, at string) (paramValue, error) {
	v, ok := c.params[id]
	if !ok {
		return paramValue{}, &SpecError{Status: 422, Problems: map[string]validation.Error{
			at: validation.NewError("unknown_param", fmt.Sprintf("the report has no param %q", id)),
		}}
	}
	return v, nil
}

func unknownColumn(at, id string) error {
	return &SpecError{Status: 422, Problems: map[string]validation.Error{
		at: validation.NewError("unknown_column", fmt.Sprintf("the report has no column %q", id)),
	}}
}

// enter guards a formula column against reading itself.
func enter(visiting map[string]bool, id, at string) (func(), error) {
	if visiting[id] {
		return nil, invalid(at, fmt.Sprintf("the formula of %q reads itself", id))
	}
	visiting[id] = true
	return func() { delete(visiting, id) }, nil
}

// joinCtx compiles inside w's own select: the filter, a group key, the
// pivot key. Paths join from the scope's base after prefix (an exists where
// reads the linked rows' paths). It reads row values only: no totals and no
// running values.
type joinCtx struct {
	r        *rowsCTE
	sc       *scope
	prefix   []hopPlan
	src      *Source
	isFilter bool
	visiting map[string]bool
}

func (j *joinCtx) col(id, at string) (expr, error) {
	if len(j.prefix) > 0 || j.sc != j.r.root {
		return expr{}, invalid(at, "a where reads paths of the linked rows, not report columns")
	}
	cp := j.r.c.p.byID[id]
	if cp == nil {
		return expr{}, unknownColumn(at, id)
	}
	done, err := enter(j.visiting, id, at)
	if err != nil {
		return expr{}, err
	}
	defer done()
	return j.r.rowValue(cp, at, j.visiting)
}

func (j *joinCtx) path(p Path, at string) (expr, error) {
	bound, err := bindValuePath(j.src, p, at, pathValue)
	if err != nil {
		return expr{}, err
	}
	hops := append(append([]hopPlan{}, j.prefix...), bound.hops...)
	return j.sc.value(&pathPlan{hops: hops, field: bound.field}), nil
}

func (j *joinCtx) param(id, at string) (expr, error) {
	v, err := paramOf(j.r.c, id, at)
	if err != nil {
		return expr{}, err
	}
	return paramExpr(j, v), nil
}

func (j *joinCtx) subtotal(_, at string) (expr, error) {
	return expr{}, invalid(at, "only a computed layout row reads a subtotal")
}

func (j *joinCtx) aggregate(op Aggregate, _ *Node, _ int, at string) (expr, error) {
	return expr{}, invalid(at, fmt.Sprintf("%s totals rows: use it in a column, not in a filter or a group", op))
}

func (j *joinCtx) window(op string, _ *Node, _ int, at string) (expr, error) {
	return expr{}, invalid(at, op+" reads the rows a report shows: use it in a column")
}

func (j *joinCtx) exists(n *Node, at string) (expr, error) {
	if !j.isFilter {
		return expr{}, invalid(at, n.Op+" belongs in the filter")
	}
	link, err := bindValuePath(j.src, n.Link, at+".link", pathLinks)
	if err != nil {
		return expr{}, err
	}
	mk := func(sc *scope, hops []hopPlan) fctx {
		src := sc.src
		if len(hops) > 0 {
			src = hops[len(hops)-1].to
		}
		return &joinCtx{r: j.r, sc: sc, prefix: hops, src: src, isFilter: true, visiting: j.visiting}
	}
	return j.sc.exists(j.prefix, link, n.Where, mk, at)
}

func (j *joinCtx) bind(v any) string   { return j.sc.s.bind(v) }
func (j *joinCtx) fiscalStart() string { return j.bind(int64(j.r.c.fiscal)) }
func (j *joinCtx) filter() bool        { return j.isFilter }
```

`$WS/tinycld/core/server/reports/rows.go`:

```go
package reports

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// compiler compiles one run of a plan: params resolved, fiscal start known.
type compiler struct {
	p      *plan
	app    core.App // nil when dry (Validate)
	info   *core.RequestInfo
	params map[string]paramValue
	fiscal int
	// currencies names w's currency keys; every total groups by them, so
	// amounts in different currencies are never added together.
	currencies []string
	// currencyOf maps a money column's id to its currency key.
	currencyOf map[string]string
	// detailTypes and levelTypes are each column's type on detail rows
	// and on group, subtotal and total rows.
	detailTypes map[string]FieldType
	levelTypes  map[string]FieldType
}

func newCompiler(p *plan, app core.App, info *core.RequestInfo, params map[string]paramValue) *compiler {
	c := &compiler{p: p, app: app, info: info, params: params, fiscal: 1, currencyOf: map[string]string{}}
	if app != nil {
		c.fiscal = fiscalStartOf(p.base, app)
	}
	if params == nil {
		// Dry: every param unset, which still has its type.
		c.params = map[string]paramValue{}
		for _, d := range p.spec.Params {
			c.params[d.ID] = paramValue{typ: d.Type, multiple: d.Multiple, unset: true}
		}
	}
	return c
}

// fiscalStartOf is the source's fiscal start month, 1 when it has none.
func fiscalStartOf(src *Source, app core.App) int {
	if src.FiscalStartMonth == nil {
		return 1
	}
	if m := src.FiscalStartMonth(app); m >= 1 && m <= 12 {
		return m
	}
	return 1
}

// rowsCTE is the CTE `w`: one row per base row the reader may list that
// passes the filter, with every value a later pass reads: group keys k<n>,
// currency keys ck<n>, the pivot key pk, path columns c<idx>, hidden path
// values h<n>, to-many parent ids p<idx> (and cs/cn for an average), and
// nest parent ids n<level>.
type rowsCTE struct {
	c      *compiler
	s      *stmt
	root   *scope
	raw    map[string]string // name → its expression inside w
	order  []string
	byExpr map[string]string
	filter string
}

func (c *compiler) rows(s *stmt) (*rowsCTE, error) {
	// Each statement builds its own w; the currency keys come out the same.
	c.currencies, c.currencyOf = nil, map[string]string{}
	r := &rowsCTE{c: c, s: s, root: newScope(s, c.p.base), raw: map[string]string{}, byExpr: map[string]string{}}
	r.add("__id", q(r.root.alias, "id"))
	if f := c.p.spec.Filter; f != nil {
		e, err := compileFormula(r.join(true), f, "filter")
		if err != nil {
			return nil, err
		}
		if e.typ != Bool {
			return nil, invalid("filter", "the filter is a condition")
		}
		r.filter = e.sql
	}
	for i, g := range c.p.groups {
		e, err := r.rowValue(g.col, g.at+".col", map[string]bool{})
		if err != nil {
			return nil, err
		}
		if g.group.Bucket != "" {
			if e.typ != Date && e.typ != DateTime {
				return nil, invalid(g.at+".bucket", "only a date column has a bucket")
			}
			e.sql = bucketSQL(r.join(false), g.group.Bucket, e.sql)
		}
		r.add(fmt.Sprintf("k%d", i), e.sql)
	}
	for _, cp := range c.p.cols {
		if cp.path == nil || cp.nest > 0 {
			continue
		}
		r.colValue(cp)
		if cp.tm < 0 && cp.path.field.Currency != "" {
			cur := cp.path.src.field(cp.path.field.Currency)
			sql := fieldSQL(r.root.join(cp.path.hops), cur)
			name, seen := r.byExpr[sql]
			if !seen {
				name = fmt.Sprintf("ck%d", len(c.currencies))
				r.byExpr[sql] = name
				r.add(name, sql)
				c.currencies = append(c.currencies, name)
			}
			c.currencyOf[cp.col.ID] = name
		}
	}
	return r, nil
}

// add puts a value in w under name, once, and returns its reference.
func (r *rowsCTE) add(name, sql string) string {
	if _, ok := r.raw[name]; !ok {
		r.raw[name] = sql
		r.order = append(r.order, name)
	}
	return "w." + name
}

// colValue puts a path column's value in w and returns its reference. A
// to-many total reads its subquery; a parent with no visible linked rows
// counts and sums to 0.
func (r *rowsCTE) colValue(cp *colPlan) expr {
	idx := r.c.p.index(cp)
	name := fmt.Sprintf("c%d", idx)
	typ := cp.path.field.Type
	if cp.tm >= 0 {
		typ = aggregateType(cp.col.Aggregate, typ, cp.scale)
	}
	if _, ok := r.raw[name]; ok {
		return expr{sql: "w." + name, typ: typ}
	}
	if cp.tm < 0 {
		r.add(name, r.root.value(cp.path).sql)
		return expr{sql: "w." + name, typ: typ}
	}
	op := cp.col.Aggregate
	value := r.root.total(cp.path, cp.tm, op, cp.scale)
	if op == Count || op == Sum {
		value = "COALESCE(" + value + ", 0)"
	}
	r.add(name, value)
	r.add(fmt.Sprintf("p%d", idx), r.root.parentID(cp.path, cp.tm))
	if op == Avg {
		r.add(fmt.Sprintf("cs%d", idx), r.root.total(cp.path, cp.tm, Sum, 0))
		r.add(fmt.Sprintf("cn%d", idx), r.root.total(cp.path, cp.tm, Count, 0))
	}
	return expr{sql: "w." + name, typ: typ}
}

// inner is the expression behind a reference to w, for use inside w's own
// select (its WHERE and its group keys).
func (r *rowsCTE) inner(ref string) string {
	if sql, ok := r.raw[strings.TrimPrefix(ref, "w.")]; ok {
		return sql
	}
	return ref
}

// hidden is a value path a formula reads, kept in w.
func (r *rowsCTE) hidden(p *pathPlan) string {
	key := "path:" + hopsKey(p.hops) + "." + p.field.Key
	if name, ok := r.byExpr[key]; ok {
		return "w." + name
	}
	name := fmt.Sprintf("h%d", len(r.order))
	r.byExpr[key] = name
	return r.add(name, r.root.value(p).sql)
}

// rowValue is a column's value per base row, as an expression inside w: a
// group key, the pivot key, or a column a filter compares.
func (r *rowsCTE) rowValue(cp *colPlan, at string, visiting map[string]bool) (expr, error) {
	if cp.nest > 0 {
		return expr{}, invalid(at, "a child row column is not a value of the report's rows")
	}
	if cp.path != nil {
		e := r.colValue(cp)
		e.sql = r.inner(e.sql)
		return e, nil
	}
	j := r.join(false)
	j.visiting = visiting
	return compileFormula(j, cp.col.Formula, cp.at+".formula")
}

func (r *rowsCTE) join(filter bool) *joinCtx {
	return &joinCtx{r: r, sc: r.root, src: r.c.p.base, isFilter: filter, visiting: map[string]bool{}}
}

func (r *rowsCTE) render() string {
	cols := make([]string, len(r.order))
	for i, name := range r.order {
		cols[i] = r.raw[name] + " AS " + name
	}
	sql := "w AS (SELECT " + strings.Join(cols, ", ") + "\n" + r.root.render()
	if r.filter != "" {
		sql += "\nWHERE " + r.filter
	}
	return sql + ")"
}

// bucketSQL buckets a date: day, month (2026-01), quarter (2026-Q1), year,
// or the base source's fiscal year.
func bucketSQL(c fctx, bucket, day string) string {
	switch bucket {
	case "day":
		return "substr(" + day + ", 1, 10)"
	case "month":
		return "substr(" + day + ", 1, 7)"
	case "quarter":
		return "(substr(" + day + ", 1, 4) || '-Q' || ((CAST(substr(" + day + ", 6, 2) AS INTEGER) + 2) / 3))"
	case "year":
		return "substr(" + day + ", 1, 4)"
	}
	return "tc_fiscal_year(" + day + ", " + c.fiscalStart() + ")"
}

func (p *plan) index(cp *colPlan) int {
	for i, x := range p.cols {
		if x == cp {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/stmt.go \
  core/server/reports/rows.go \
  core/server/reports/join.go \
  core/server/reports/rows_test.go
git commit -m "feat(core): report rows CTE with rule CTEs, joins, exists and per-parent totals"
```

---

### Task 10: `Run`: detail rows, group levels, totals and running values

**Files:**
- Create: `$WS/tinycld/core/server/reports/detail.go` (detail-row formulas and window functions)
- Create: `$WS/tinycld/core/server/reports/levels.go` (one level of the group statement)
- Create: `$WS/tinycld/core/server/reports/run.go` (`Run`, its types, the passes, expansion)
- Create: `$WS/tinycld/core/server/reports/assemble.go` (the result's columns and rows)
- Modify: `$WS/tinycld/core/server/reports/bind.go` (`Validate` compiles the spec)
- Test: `$WS/tinycld/core/server/reports/run_test.go`, `$WS/tinycld/core/server/reports/groups_test.go`

The group statement is the `UNION ALL` of every level (`o0` the total, `o<L>` the groups of the first L group columns), each level grouped by its keys and the currency keys, ordered by `__level, __ord`, capped at `rowCap + 1`. The detail statement selects every `w` row (the rows of expanded innermost groups when there are groups), computes windows over all of them, then filters. Until Task 11 a report without groups returns its detail rows up to the row cap; until Tasks 12–14 a pivot, a layout and nested columns are validated but not run.

**Interfaces:**
- Consumes: Tasks 2–9 (`changesignal.TopicsRead`, `bind`, `resolveParams`, `isDay`, `newCompiler`, `rows`, `scanRows`, `listRequestInfo`, `fiscalStartOf`).
- Produces:
  - `type Options struct{ Expand [][]any; ExpandAll bool; Cursor string; Limit int; Today string; Display json.RawMessage }`.
  - `type Request struct{ Spec *Spec; Loaded *LoadInfo; Params map[string]json.RawMessage; Options Options; Auth *core.Record; Headers map[string]string }`.
  - `type Result struct{ Columns []ResultColumn; Rows []Row; Notices []Notice; Topics []string; Page *Page }`, `ResultColumn{ID, Label, Type, TotalType, Aggregate, Format, Options, Currency, CurrencyCell, MixedCurrency, Pivot *PivotColumn}`, `PivotColumn{Cell, Key}`, `Row{ID, Kind, Depth, Label, Section, Parent, GroupKey, Expanded, Cells}`, `Notice{Code, Message, Columns, Count, Aliases}`, `Page{Next, Size}`; kinds `KindDetail`, `KindGroup`, `KindSubtotal`, `KindComputed`, `KindTotal`.
  - `func Run(ctx context.Context, app core.App, req Request) (*Result, error)`; errors `ErrTimeout`, `ErrAmountTooLarge`, `ErrNoReader`, and `*SpecError`.
  - `type limits struct{ timeout time.Duration; rowCap, pageSize, maxPage int }`; `var runLimits = limits{10 * time.Second, 5000, 200, 1000}`.
  - `runner{ctx, app, c, opts, expand, res, topics}` with `query(s, ctes, body)`, `groupPass()`, `detailPass()`, `notice(n)`; `(*compiler).groupStatement(s, r, expand)`, `(*compiler).detailSelect(r) (string, []sortKey, error)`, `(*compiler).level(r, n) (*level, error)`; `sortKey{name, desc}`, `orderBy(keys) string`, `dirOf(desc) string`; `expansion{all, keys}` with `where(c, s, depth, prefix)` and `has(key)`; `compileDry(p *plan) error`.
  - `rowsCtx`, `windowFrame{parent, total, order}`, `windowSQL`, `partitionBy` (`detail.go`); `level` and `levelCtx` (`levels.go`); assembly in `assemble.go`: `columns`, `currencyOfColumn`, `labelOf`, `markCurrencies`, `tree`, `keyString`, `rowKey`, `currencyKey`, `assemble(groupRows, details)`, `currencySuffix`, `push`, `group`, `groupWithLabel(t, row, n, section, id, label, key, subtotal)`, `detail(t, row, section, depth)`, `cells`, `cellValue`, `typeOf`, `firstLabel`, `display`, `toInt`; `const blankLabel = "(none)"`.
  - Test helpers in `run_test.go`: `(z *zoo).run(t, user, raw, opts, params) *Result`, `(z *zoo).try(...) (*Result, error)`, `withLimits(t, edit func(*limits))`, `rowsOf`, `requireRows(t, res, what, want...)`, `sprintf`, `const feedingsByDay`; in `groups_test.go`: `const feedingsBySpecies`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/run_test.go`:

```go
package reports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// run loads and runs a spec as user, failing the test on an error.
func (z *zoo) run(t *testing.T, user, raw string, opts Options, params map[string]string) *Result {
	t.Helper()
	res, err := z.try(t, user, raw, opts, params)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return res
}

func (z *zoo) try(t *testing.T, user, raw string, opts Options, params map[string]string) (*Result, error) {
	t.Helper()
	spec, info, err := Load([]byte(raw))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	given := map[string]json.RawMessage{}
	for k, v := range params {
		given[k] = json.RawMessage(v)
	}
	return Run(context.Background(), z.app, Request{Spec: spec, Loaded: info, Params: given, Options: opts, Auth: z.recs[user]})
}

// withLimits changes the run limits for one test.
func withLimits(t *testing.T, edit func(*limits)) {
	t.Helper()
	saved := runLimits
	edit(&runLimits)
	t.Cleanup(func() { runLimits = saved })
}

// rowsOf lists the rows' ids, kinds or labels, or one cell, in order.
func rowsOf(res *Result, what string) []any {
	out := make([]any, len(res.Rows))
	for i, r := range res.Rows {
		switch what {
		case "kind":
			out[i] = r.Kind
		case "label":
			out[i] = r.Label
		default:
			out[i] = r.Cells[what]
		}
	}
	return out
}

func requireRows(t *testing.T, res *Result, what string, want ...any) {
	t.Helper()
	if got := rowsOf(res, what); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s = %#v\nwant   %#v", what, got, want)
	}
}

const feedingsByDay = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"note","path":[{"field":"note"}]},
	{"id":"fed","path":[{"field":"fed"}]},
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"active","path":[{"link":"animal"},{"field":"active"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
	"sort":[{"col":"fed"}]}`

func TestRunDetailRowsAndTheTotal(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", feedingsByDay, Options{}, nil)
	requireRows(t, res, "kind", "detail", "detail", "detail", "detail", "total")
	requireRows(t, res, "note", "f1", "f3", "f2", "f4", nil)
	requireRows(t, res, "fed", "2026-01-05", "2026-01-20", "2026-02-10", "2026-03-03", nil)
	requireRows(t, res, "active", true, true, true, true, nil)
	requireRows(t, res, "cost", int64(1000), int64(700), int64(2500), int64(300), int64(4500))
	requireRows(t, res, "label", "f1", "f3", "f2", "f4", "Total")
	if res.Rows[0].ID != "d:"+z.id("f1") || res.Rows[4].ID != `total:["USD"]` {
		t.Fatalf("ids = %s, %s", res.Rows[0].ID, res.Rows[4].ID)
	}
	bob := z.run(t, "bob", feedingsByDay, Options{}, nil)
	requireRows(t, bob, "note", "f3", "f5", "f4", nil)
	requireRows(t, bob, "cost", int64(700), int64(150), int64(300), int64(1150))
}

func TestRunDescribesItsColumns(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"name","path":[{"field":"name"}],"aggregate":"count","format":"plain"},
		{"id":"region","label":"Where","path":[{"link":"site"},{"field":"region"}]},
		{"id":"price","path":[{"field":"price"}],"aggregate":"sum"}],
		"sort":[{"col":"name"}]}`, Options{}, nil)
	want := []ResultColumn{
		{ID: "name", Label: "Name", Type: Text, TotalType: Number, Aggregate: Count, Format: "plain"},
		{ID: "region", Label: "Where", Type: Select, Options: []Option{{Value: "north", Label: "North"}, {Value: "south", Label: "South"}}},
		{ID: "price", Label: "Price", Type: Money, Aggregate: Sum, Currency: "USD"},
	}
	if !reflect.DeepEqual(res.Columns, want) {
		t.Fatalf("columns = %+v", res.Columns)
	}
	requireRows(t, res, "name", "Kit", "Leo", "Zed", int64(3))
}

func TestRunTotalsMoneyExactly(t *testing.T) {
	z := newZoo(t)
	// 2^53 + 1 is not a float64; a float sum would lose the 1.
	if _, err := z.app.DB().NewQuery("UPDATE zoo_feedings SET cost = 9007199254740993 WHERE note = 'f1'").Execute(); err != nil {
		t.Fatal(err)
	}
	res := z.run(t, "ann", feedingsByDay, Options{}, nil)
	if got := res.Rows[len(res.Rows)-1].Cells["cost"]; got != int64(9007199254744493) {
		t.Fatalf("total = %#v", got)
	}
}

func TestRunReportsAnAmountTooLarge(t *testing.T) {
	z := newZoo(t)
	if _, err := z.app.DB().NewQuery("UPDATE zoo_feedings SET cost = 9223372036854775807 WHERE note IN ('f1', 'f2')").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := z.try(t, "ann", feedingsByDay, Options{}, nil); !errors.Is(err, ErrAmountTooLarge) {
		t.Fatalf("err = %v, want ErrAmountTooLarge", err)
	}
}

func TestRunStopsAtTheTimeLimit(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.timeout = time.Nanosecond })
	if _, err := z.try(t, "ann", feedingsByDay, Options{}, nil); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
}

func TestRunListsTheTopicsOfEveryCollectionItReads(t *testing.T) {
	z := newZoo(t)
	// The feedings rule reads zoo_keepers; the animals rule reads it too.
	res := z.run(t, "ann", feedingsByDay, Options{}, nil)
	want := []string{"collection/zoo_animals", "collection/zoo_feedings", "collection/zoo_keepers"}
	if !reflect.DeepEqual(res.Topics, want) {
		t.Fatalf("topics = %v", res.Topics)
	}
	sites := z.run(t, "ann", `{"version":1,"source":"zoo.sites","columns":[{"id":"n","path":[{"field":"name"}]}]}`, Options{}, nil)
	if !reflect.DeepEqual(sites.Topics, []string{"collection/zoo_sites"}) {
		t.Fatalf("topics = %v", sites.Topics)
	}
}

func TestRunNeedsAReader(t *testing.T) {
	z := newZoo(t)
	spec, _, _ := Load([]byte(feedingsByDay))
	if _, err := Run(context.Background(), z.app, Request{Spec: spec}); !errors.Is(err, ErrNoReader) {
		t.Fatalf("no reader: %v", err)
	}
	superusers, err := z.app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), z.app, Request{Spec: spec, Auth: core.NewRecord(superusers)}); !errors.Is(err, ErrNoReader) {
		t.Fatalf("superuser: %v", err)
	}
}

func TestRunReturnsSpecErrors(t *testing.T) {
	z := newZoo(t)
	_, err := z.try(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[{"id":"n","path":[{"field":"note"}]}],"sort":[{"col":"x"}]}`, Options{}, nil)
	requireSpecError(t, err, 422, "sort.0.col", "no column")
	_, err = z.try(t, "ann", feedingsByDay, Options{Today: "2026-13-01"}, nil)
	requireSpecError(t, err, 400, "options.today", "YYYY-MM-DD")
}

func TestRunNoticesRenamedFieldsAndAnUpgrade(t *testing.T) {
	z := newZoo(t)
	spec, info, err := Load([]byte(`{"version":1,"source":"zoo.animals","columns":[{"id":"w","path":[{"field":"mass"}],"aggregate":"sum"}],"sort":[{"col":"w"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	info.UpgradedFrom = 1
	res, err := Run(context.Background(), z.app, Request{Spec: spec, Loaded: info, Auth: z.recs["ann"]})
	if err != nil {
		t.Fatal(err)
	}
	codes := []string{}
	for _, n := range res.Notices {
		codes = append(codes, n.Code)
	}
	if !reflect.DeepEqual(codes, []string{"upgraded", "aliased"}) || res.Notices[1].Aliases[0].From != "mass" {
		t.Fatalf("notices = %+v", res.Notices)
	}
	requireRows(t, res, "w", int64(4), int64(190), int64(300), int64(494))
}

func TestRunResolvesPresetsWithTheReadersDay(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.feedings",
		"params":[{"id":"period","type":"dateRange","default":{"preset":"thisMonth"}}],
		"columns":[{"id":"note","path":[{"field":"note"}]}],
		"filter":{"op":"between","args":[{"path":[{"field":"fed"}]},{"param":"period"}]},
		"sort":[{"col":"note"}]}`
	requireRows(t, z.run(t, "ann", spec, Options{Today: "2026-01-15"}, nil), "note", "f1", "f3", nil)
	requireRows(t, z.run(t, "ann", spec, Options{Today: "2026-02-15"}, nil), "note", "f2", nil)
	requireRows(t, z.run(t, "ann", spec, Options{Today: "2026-02-15"}, map[string]string{"period": `{"preset":"lastMonth"}`}), "note", "f1", "f3", nil)
}

func TestRunFormulasOnDetailRowsAndTotals(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"note","path":[{"field":"note"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
		{"id":"grams","path":[{"field":"grams"}],"aggregate":"sum"},
		{"id":"double","formula":{"op":"mul","args":[{"col":"cost"},{"value":2}]},"aggregate":"sum"},
		{"id":"perGram","formula":{"op":"div","args":[{"col":"cost"},{"col":"grams"}],"scale":0}},
		{"id":"largest","formula":{"op":"max","args":[{"path":[{"field":"cost"}]}]}}],
		"sort":[{"col":"note"}]}`, Options{}, nil)
	requireRows(t, res, "double", int64(2000), int64(5000), int64(1400), int64(600), int64(9000))
	// A formula with no aggregate is computed again from each row's
	// values: the total's is 4500 / 1700, not a sum of the rows'.
	requireRows(t, res, "perGram", int64(2), int64(3), int64(2), int64(3), int64(3))
	// An aggregate in a formula is the aggregate of one detail row.
	requireRows(t, res, "largest", int64(1000), int64(2500), int64(700), int64(300), int64(2500))
}

func sprintf(format string, args ...any) string { return fmt.Sprintf(format, args...) }
```

`$WS/tinycld/core/server/reports/groups_test.go`:

```go
package reports

import (
	"reflect"
	"testing"
)

const feedingsBySpecies = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"note","path":[{"field":"note"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
	"groups":[{"id":"bySpecies","col":"species","subtotals":true}],
	"sort":[{"col":"note"}]}`

func TestGroupsLoadLazily(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", feedingsBySpecies, Options{}, nil)
	requireRows(t, res, "kind", "group", "group", "total")
	requireRows(t, res, "label", "lion", "zebra", "Total")
	requireRows(t, res, "cost", int64(3500), int64(1000), int64(4500))
	lion := res.Rows[0]
	if !reflect.DeepEqual(lion.GroupKey, []any{"lion", "USD"}) || lion.Expanded || lion.ID != `g:["lion","USD"]` {
		t.Fatalf("lion = %+v", lion)
	}

	open := z.run(t, "ann", feedingsBySpecies, Options{Expand: [][]any{lion.GroupKey}}, nil)
	requireRows(t, open, "kind", "group", "detail", "detail", "subtotal", "group", "total")
	requireRows(t, open, "note", nil, "f1", "f2", nil, nil, nil)
	requireRows(t, open, "label", "lion", "lion", "lion", "Total lion", "zebra", "Total")
	if !open.Rows[0].Expanded || open.Rows[1].Section != lion.ID || open.Rows[1].Depth != 1 || open.Rows[3].Section != lion.ID {
		t.Fatalf("rows = %+v", open.Rows[:4])
	}
}

func TestTwoGroupLevels(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"site","path":[{"link":"animal"},{"link":"site"},{"field":"name"}]},
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"note","path":[{"field":"note"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"bySite","col":"site","subtotals":true},{"id":"bySpecies","col":"species"}],
		"sort":[{"col":"note"}]}`
	res := z.run(t, "bob", spec, Options{}, nil)
	requireRows(t, res, "label", "North", "South", "Total")
	requireRows(t, res, "cost", int64(150), int64(1000), int64(1150))

	north := res.Rows[0].GroupKey
	res = z.run(t, "bob", spec, Options{Expand: [][]any{north}}, nil)
	requireRows(t, res, "label", "North", "monkey", "Total North", "South", "Total")
	requireRows(t, res, "site", "North", "North", "North", "South", nil)
	if res.Rows[1].Depth != 1 || res.Rows[1].Expanded || !reflect.DeepEqual(res.Rows[1].GroupKey, []any{"North", "monkey", "USD"}) {
		t.Fatalf("monkey = %+v", res.Rows[1])
	}

	res = z.run(t, "bob", spec, Options{Expand: [][]any{north, {"North", "monkey", "USD"}}}, nil)
	requireRows(t, res, "label", "North", "monkey", "North", "Total North", "South", "Total")
	requireRows(t, res, "note", nil, nil, "f5", nil, nil, nil)
	if res.Rows[2].Depth != 2 {
		t.Fatalf("detail depth = %d", res.Rows[2].Depth)
	}

	all := z.run(t, "bob", spec, Options{ExpandAll: true}, nil)
	requireRows(t, all, "kind", "group", "group", "detail", "subtotal", "group", "group", "detail", "detail", "subtotal", "total")
	requireRows(t, all, "note", nil, nil, "f5", nil, nil, nil, "f3", "f4", nil, nil)
}

func TestAToManyTotalCountsEachParentOnce(t *testing.T) {
	z := newZoo(t)
	// Each feeding row carries its animal's keeper count. Leo has two
	// feedings: adding the per-row counts would count leo's keeper twice.
	res := z.run(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"site","path":[{"link":"animal"},{"link":"site"},{"field":"name"}]},
		{"id":"keepers","path":[{"link":"animal"},{"link":"keepers","mode":"aggregate"},{"field":"id"}],"aggregate":"count"},
		{"id":"grams","path":[{"link":"animal"},{"link":"feedings","mode":"aggregate"},{"field":"grams"}],"aggregate":"avg","scale":0}],
		"groups":[{"id":"bySite","col":"site"}]}`, Options{ExpandAll: true}, nil)
	requireRows(t, res, "kind", "group", "detail", "detail", "group", "detail", "detail", "total")
	requireRows(t, res, "keepers", int64(1), int64(1), int64(1), int64(1), int64(1), int64(1), int64(2))
	// Leo's feedings average 650 g, zed's 200 g; together (1300 + 400) / 4.
	requireRows(t, res, "grams", int64(650), int64(650), int64(650), int64(200), int64(200), int64(200), int64(425))
}

func TestGroupsSortByTheirTotals(t *testing.T) {
	z := newZoo(t)
	spec := `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"species"}],"sort":[{"col":"cost","dir":"%s"}]}`
	requireRows(t, z.run(t, "ann", sprintf(spec, "asc"), Options{}, nil), "label", "zebra", "lion", "Total")
	requireRows(t, z.run(t, "ann", sprintf(spec, "desc"), Options{}, nil), "label", "lion", "zebra", "Total")
}

func TestGroupByAMonthBucket(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"fed","path":[{"field":"fed"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"fed","bucket":"month"}]}`, Options{}, nil)
	requireRows(t, res, "label", "2026-01", "2026-02", "2026-03", "Total")
	requireRows(t, res, "cost", int64(1700), int64(2500), int64(300), int64(4500))
	// A bucketed group column has no single value on its group row.
	requireRows(t, res, "fed", nil, nil, nil, nil)
}

func TestGroupLabelsUseSelectLabelsAndNone(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.animals","columns":[
		{"id":"region","path":[{"link":"site"},{"field":"region"}]},
		{"id":"weight","path":[{"field":"weight"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"region"}]}`, Options{}, nil)
	requireRows(t, res, "label", "North", "South", "(none)", "Total")
	requireRows(t, res, "weight", int64(190), int64(300), int64(4), int64(494))
}

func TestAmountsInDifferentCurrenciesAreTotalledApart(t *testing.T) {
	z := newZoo(t)
	z.rec(t, "f7", "zoo_feedings", map[string]any{
		"animal": z.id("zed"), "cost": 400, "currency": "EUR", "fed": "2026-03-10 00:00:00.000Z", "grams": 10, "note": "f7",
	})
	res := z.run(t, "ann", feedingsBySpecies, Options{}, nil)
	requireRows(t, res, "label", "zebra", "Total", "lion", "zebra", "Total")
	requireRows(t, res, "cost@currency", "EUR", "EUR", "USD", "USD", "USD")
	requireRows(t, res, "cost", int64(400), int64(400), int64(3500), int64(1000), int64(4500))
	if !res.Columns[2].MixedCurrency || res.Columns[2].CurrencyCell != "cost@currency" {
		t.Fatalf("cost column = %+v", res.Columns[2])
	}
	if len(res.Notices) != 1 || res.Notices[0].Code != "mixedCurrency" || !reflect.DeepEqual(res.Notices[0].Columns, []string{"cost"}) {
		t.Fatalf("notices = %+v", res.Notices)
	}
}

func TestGroupRowsStopAtTheRowCap(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 2 })
	res := z.run(t, "ann", feedingsBySpecies, Options{}, nil)
	if len(res.Notices) != 1 || res.Notices[0].Code != "rowCap" || res.Notices[0].Count != 2 {
		t.Fatalf("notices = %+v", res.Notices)
	}
}

func TestRunningValuesAndPercents(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"note","path":[{"field":"note"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
		{"id":"running","formula":{"op":"runningSum","args":[{"col":"cost"}]}},
		{"id":"ofParent","formula":{"op":"percentOfParent","args":[{"col":"cost"}],"scale":1}},
		{"id":"ofTotal","formula":{"op":"percentOfTotal","args":[{"col":"cost"}],"scale":1}}],
		"groups":[{"id":"g","col":"species"}],"sort":[{"col":"note"}]}`, Options{ExpandAll: true}, nil)
	requireRows(t, res, "note", nil, "f1", "f2", nil, "f3", "f4", nil)
	// Running sums restart in each group; group rows run across groups.
	requireRows(t, res, "running", int64(3500), int64(1000), int64(3500), int64(4500), int64(700), int64(1000), int64(4500))
	requireRows(t, res, "ofParent", 77.8, 28.6, 71.4, 22.2, 70.0, 30.0, 100.0)
	requireRows(t, res, "ofTotal", 77.8, 22.2, 55.6, 22.2, 15.6, 6.7, 100.0)
}

func TestARunningValueIsNotASortKey(t *testing.T) {
	z := newZoo(t)
	_, err := z.try(t, "ann", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
		{"id":"running","formula":{"op":"runningSum","args":[{"col":"cost"}]}}],
		"sort":[{"col":"running"}]}`, Options{}, nil)
	requireSpecError(t, err, 400, "sort.0.col", "not a sort key")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: Options`, `undefined: Result`, `undefined: Run`, …

- [ ] **Step 3: Write detail rows and levels**

`$WS/tinycld/core/server/reports/detail.go`:

```go
package reports

import (
	"fmt"
	"strings"
)

// rowsCtx compiles over w, one row per base row: a detail row's cells, and
// the value inside an aggregate. Inside an aggregate it reads no to-many
// total (a total of per-parent totals double-counts) and no other total.
type rowsCtx struct {
	r           *rowsCTE
	inAggregate bool
	// detail orders and partitions the detail rows for running values;
	// nil inside an aggregate.
	detail   *windowFrame
	visiting map[string]bool
}

// windowFrame is where a running value or a percent reads its rows: the
// partition of the row's parent, the partition of the whole report, and the
// row order.
type windowFrame struct {
	parent []string
	total  []string
	order  []string
}

func (rc *rowsCtx) col(id, at string) (expr, error) {
	cp := rc.r.c.p.byID[id]
	if cp == nil {
		return expr{}, unknownColumn(at, id)
	}
	if cp.nest > 0 {
		return expr{}, invalid(at, "a formula does not read child row columns")
	}
	if cp.path != nil {
		if cp.tm >= 0 && rc.inAggregate {
			return expr{}, invalid(at, fmt.Sprintf("a total of %q, itself a total across a to-many link, would double-count: use the column's own aggregate", id))
		}
		return rc.r.colValue(cp), nil
	}
	done, err := enter(rc.visiting, id, at)
	if err != nil {
		return expr{}, err
	}
	defer done()
	return compileFormula(rc, cp.col.Formula, cp.at+".formula")
}

func (rc *rowsCtx) path(p Path, at string) (expr, error) {
	bound, err := bindValuePath(rc.r.c.p.base, p, at, pathValue)
	if err != nil {
		return expr{}, err
	}
	return expr{sql: rc.r.hidden(bound), typ: bound.field.Type}, nil
}

func (rc *rowsCtx) param(id, at string) (expr, error) {
	v, err := paramOf(rc.r.c, id, at)
	if err != nil {
		return expr{}, err
	}
	return paramExpr(rc, v), nil
}

func (rc *rowsCtx) subtotal(_, at string) (expr, error) {
	return expr{}, invalid(at, "only a computed layout row reads a subtotal")
}

// aggregate on a detail row is the aggregate of one row: sum(x) is x.
func (rc *rowsCtx) aggregate(op Aggregate, arg *Node, scale int, at string) (expr, error) {
	if rc.inAggregate {
		return expr{}, invalid(at, "a total inside a total")
	}
	inner := &rowsCtx{r: rc.r, inAggregate: true, visiting: rc.visiting}
	e, err := compileFormula(inner, arg, at+".args.0")
	if err != nil {
		return expr{}, err
	}
	if err := checkAggregate(op, e.typ, scale, at+".args.0"); err != nil {
		return expr{}, err
	}
	typ := aggregateType(op, e.typ, scale)
	switch op {
	case Sum:
		return expr{sql: "COALESCE(" + e.sql + ", 0)", typ: typ}, nil
	case Count, CountDistinct:
		return expr{sql: "(" + e.sql + " IS NOT NULL)", typ: typ}, nil
	case Avg:
		return expr{sql: fmt.Sprintf("tc_round(%s, %d)", e.sql, scale), typ: typ}, nil
	}
	return expr{sql: e.sql, typ: typ}, nil
}

func (rc *rowsCtx) window(op string, arg *Node, scale int, at string) (expr, error) {
	if rc.detail == nil {
		return expr{}, invalid(at, op+" cannot be inside a total")
	}
	e, err := compileFormula(rc, arg, at+".args.0")
	if err != nil {
		return expr{}, err
	}
	return windowSQL(op, e, scale, rc.detail, at)
}

func (rc *rowsCtx) exists(n *Node, at string) (expr, error) {
	return expr{}, invalid(at, n.Op+" belongs in the filter")
}

func (rc *rowsCtx) bind(v any) string   { return rc.r.s.bind(v) }
func (rc *rowsCtx) fiscalStart() string { return rc.bind(int64(rc.r.c.fiscal)) }
func (rc *rowsCtx) filter() bool        { return false }

// windowSQL is a running value or a percent over a frame. A running sum
// adds in the frame's order within the parent; a percent divides by the sum
// over the parent or over the whole report, with no figure when that sum is
// zero.
func windowSQL(op string, e expr, scale int, f *windowFrame, at string) (expr, error) {
	if !isNumeric(e.typ) || e.win {
		return expr{}, invalid(at, op+" needs a number that is not itself a running value")
	}
	switch op {
	case "runningSum":
		over := "OVER (" + partitionBy(f.parent) + " ORDER BY " + strings.Join(f.order, ", ") + " ROWS UNBOUNDED PRECEDING)"
		return expr{sql: "SUM(" + num(e) + ") " + over, typ: sumType([]expr{e}), win: true}, nil
	case "percentOfParent":
		return expr{sql: fmt.Sprintf("tc_pct(%s, SUM(%s) OVER (%s), %d)", num(e), num(e), partitionBy(f.parent), scale), typ: Percent, win: true}, nil
	}
	return expr{sql: fmt.Sprintf("tc_pct(%s, SUM(%s) OVER (%s), %d)", num(e), num(e), partitionBy(f.total), scale), typ: Percent, win: true}, nil
}

func partitionBy(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return "PARTITION BY " + strings.Join(keys, ", ")
}
```

`$WS/tinycld/core/server/reports/levels.go`:

```go
package reports

import (
	"fmt"
	"slices"
	"strings"
)

// level is one level of the group statement over w: level 0 is the total,
// level L the groups of the first L group columns. Each level groups by its
// keys and by the currency keys, so a total never adds two currencies.
//
//	a<L>  aggregates w by the level's keys
//	d<L>_<idx>  a to-many total, once per parent row (aggregate locality)
//	g<L>  a<L> with its to-many totals
//	o<L>  the level's cells, and its rows' order among siblings
type level struct {
	c        *compiler
	r        *rowsCTE
	n        int
	keys     []string // w columns the level groups by
	aggs     []string // a<L> values, "expr AS name"
	aggNames map[string]bool
	tms      []string // d<L> CTEs
	tmCols   []string // g<L> values taken from d<L>
	frame    *windowFrame
	visiting map[string]bool
	cellType map[string]FieldType
}

// level prepares level n: its keys, its parent partition, and the order of
// its sibling rows, which running values read.
func (c *compiler) level(r *rowsCTE, n int) (*level, error) {
	lv := &level{c: c, r: r, n: n, aggNames: map[string]bool{}, visiting: map[string]bool{}, cellType: map[string]FieldType{}}
	for i := range n {
		lv.keys = append(lv.keys, fmt.Sprintf("k%d", i))
	}
	lv.keys = append(lv.keys, c.currencies...)
	parent := slices.Clone(c.currencies)
	for i := range max(n-1, 0) {
		parent = append(parent, fmt.Sprintf("k%d", i))
	}
	lv.frame = &windowFrame{parent: prefixed("a.", parent), total: prefixed("a.", c.currencies)}
	order, err := lv.order()
	if err != nil {
		return nil, err
	}
	lv.frame.order = order
	return lv, nil
}

func prefixed(prefix string, names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = prefix + n
	}
	return out
}

// agg adds an aggregate over w to a<L> and returns its reference.
func (lv *level) agg(name, sql string) string {
	if !lv.aggNames[name] {
		lv.aggNames[name] = true
		lv.aggs = append(lv.aggs, sql+" AS "+name)
	}
	return "a." + name
}

// toManyTotal totals a to-many column once per parent row in the group:
// every base row that shares a parent carries the same per-parent total,
// so adding it up per base row would multiply it.
func (lv *level) toManyTotal(cp *colPlan) string {
	idx := lv.c.p.index(cp)
	name := fmt.Sprintf("x%d", idx)
	if lv.aggNames[name] {
		return "a." + name
	}
	lv.aggNames[name] = true
	cols := []string{fmt.Sprintf("p%d", idx), fmt.Sprintf("c%d", idx)}
	var total string
	switch cp.col.Aggregate {
	case Min, Max:
		total = fmt.Sprintf("%s(c%d)", cp.col.Aggregate, idx)
	case Avg:
		cols = append(cols, fmt.Sprintf("cs%d", idx), fmt.Sprintf("cn%d", idx))
		total = fmt.Sprintf("(CASE WHEN COALESCE(sum(cn%[1]d), 0) = 0 THEN NULL ELSE tc_div(sum(cs%[1]d), sum(cn%[1]d), %[2]d) END)", idx, cp.scale)
	default:
		total = fmt.Sprintf("COALESCE(sum(c%d), 0)", idx)
	}
	d := fmt.Sprintf("d%d_%d", lv.n, idx)
	lv.tms = append(lv.tms, fmt.Sprintf("%s AS (SELECT %s FROM (SELECT DISTINCT %s FROM w)%s)",
		d, strings.Join(append(slices.Clone(lv.keys), total+" AS "+name), ", "),
		strings.Join(append(slices.Clone(lv.keys), cols...), ", "), groupBy(lv.keys)))
	lv.tmCols = append(lv.tmCols, d)
	return "a." + name
}

func groupBy(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return " GROUP BY " + strings.Join(keys, ", ")
}

// cell is a column's value on this level's rows.
func (lv *level) cell(cp *colPlan) (expr, error) {
	ctx := &levelCtx{lv: lv, visiting: lv.visiting}
	return ctx.col(cp.col.ID, cp.at)
}

// order sorts sibling rows: by the spec's sort keys that mean something on
// this level (a total, a formula, this level's own group column), then by
// the level's key.
func (lv *level) order() ([]string, error) {
	var out []string
	for i, s := range lv.c.p.sort {
		e, ok, err := lv.sortValue(s.col, fmt.Sprintf("sort.%d.col", i))
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		dir := ""
		if s.desc {
			dir = " DESC"
		}
		out = append(out, "("+e+" IS NULL)", e+dir)
	}
	if lv.n > 0 {
		key := fmt.Sprintf("a.k%d", lv.n-1)
		out = append(out, "("+key+" IS NULL)", key)
	}
	if len(out) == 0 {
		out = []string{"1"}
	}
	return out, nil
}

func (lv *level) sortValue(cp *colPlan, at string) (string, bool, error) {
	if cp.path != nil && cp.col.Aggregate == "" && lv.groupKey(cp) == "" {
		return "", false, nil
	}
	e, err := lv.cell(cp)
	if err != nil {
		return "", false, err
	}
	if e.win {
		return "", false, invalid(at, "a running value or a percent is not a sort key")
	}
	return e.sql, true, nil
}

// groupKey is the key of the group column cp on this level, or "".
func (lv *level) groupKey(cp *colPlan) string {
	for i, g := range lv.c.p.groups {
		if i < lv.n && g.col == cp && g.group.Bucket == "" {
			return fmt.Sprintf("a.k%d", i)
		}
	}
	return ""
}

// render returns the level's CTEs; o<L> selects the given cells.
func (lv *level) render(cells []string) []string {
	a := fmt.Sprintf("a%d", lv.n)
	keyCols := slices.Clone(lv.keys)
	// __n counts the base rows of the group; it also keeps the select of a
	// level with no aggregate valid.
	ctes := []string{fmt.Sprintf("%s AS (SELECT %s FROM w%s)", a,
		strings.Join(append(append(keyCols, lv.aggs...), "count(*) AS __n"), ", "), groupBy(lv.keys))}
	ctes = append(ctes, lv.tms...)
	g := a
	if len(lv.tmCols) > 0 {
		g = fmt.Sprintf("g%d", lv.n)
		sel := []string{"a.*"}
		joins := []string{}
		for _, d := range lv.tmCols {
			idx := strings.SplitN(d, "_", 2)[1]
			sel = append(sel, d+".x"+idx)
			on := []string{"1"}
			for _, k := range lv.keys {
				on = append(on, fmt.Sprintf("%s.%s IS a.%s", d, k, k))
			}
			joins = append(joins, fmt.Sprintf("LEFT JOIN %s ON %s", d, strings.Join(on, " AND ")))
		}
		ctes = append(ctes, fmt.Sprintf("%s AS (SELECT %s FROM %s a %s)", g, strings.Join(sel, ", "), a, strings.Join(joins, " ")))
	}
	out := []string{fmt.Sprintf("%d AS __level", lv.n), "NULL AS __row"}
	for i := range lv.c.p.groups {
		if i < lv.n {
			out = append(out, fmt.Sprintf("a.k%d AS k%d", i, i))
		} else {
			out = append(out, fmt.Sprintf("NULL AS k%d", i))
		}
	}
	for _, ck := range lv.c.currencies {
		out = append(out, "a."+ck+" AS "+ck)
	}
	out = append(out, cells...)
	out = append(out, fmt.Sprintf("ROW_NUMBER() OVER (%s ORDER BY %s) AS __ord", partitionBy(lv.frame.parent), strings.Join(lv.frame.order, ", ")))
	ctes = append(ctes, fmt.Sprintf("o%d AS (SELECT %s FROM %s a)", lv.n, strings.Join(out, ", "), g))
	return ctes
}

// levelCtx compiles a cell of a group, subtotal or total row from the
// level's aggregates.
type levelCtx struct {
	lv       *level
	visiting map[string]bool
}

func (lc *levelCtx) col(id, at string) (expr, error) {
	lv := lc.lv
	cp := lv.c.p.byID[id]
	if cp == nil {
		return expr{}, unknownColumn(at, id)
	}
	idx := lv.c.p.index(cp)
	name := fmt.Sprintf("x%d", idx)
	switch {
	case cp.nest > 0:
		return expr{sql: "NULL", typ: cp.path.field.Type}, nil
	case cp.path != nil && cp.tm >= 0:
		return expr{sql: lv.toManyTotal(cp), typ: aggregateType(cp.col.Aggregate, cp.path.field.Type, cp.scale)}, nil
	case cp.path != nil && cp.col.Aggregate != "":
		return expr{sql: lv.agg(name, aggregateSQL(cp.col.Aggregate, fmt.Sprintf("w.c%d", idx), cp.scale)),
			typ: aggregateType(cp.col.Aggregate, cp.path.field.Type, cp.scale)}, nil
	case cp.path != nil:
		if key := lv.groupKey(cp); key != "" {
			return expr{sql: key, typ: cp.path.field.Type}, nil
		}
		return expr{sql: "NULL", typ: cp.path.field.Type}, nil
	}
	done, err := enter(lc.visiting, id, at)
	if err != nil {
		return expr{}, err
	}
	defer done()
	if cp.col.Aggregate == "" {
		return compileFormula(lc, cp.col.Formula, cp.at+".formula")
	}
	inner := &rowsCtx{r: lv.r, inAggregate: true, visiting: lc.visiting}
	e, err := compileFormula(inner, cp.col.Formula, cp.at+".formula")
	if err != nil {
		return expr{}, err
	}
	if err := checkAggregate(cp.col.Aggregate, e.typ, cp.scale, cp.at+".aggregate"); err != nil {
		return expr{}, err
	}
	return expr{sql: lv.agg(name, aggregateSQL(cp.col.Aggregate, e.sql, cp.scale)), typ: aggregateType(cp.col.Aggregate, e.typ, cp.scale)}, nil
}

func (lc *levelCtx) path(_ Path, at string) (expr, error) {
	return expr{}, invalid(at, "a total row reads a path only inside an aggregate such as sum")
}

func (lc *levelCtx) param(id, at string) (expr, error) {
	v, err := paramOf(lc.lv.c, id, at)
	if err != nil {
		return expr{}, err
	}
	return paramExpr(lc, v), nil
}

func (lc *levelCtx) subtotal(_, at string) (expr, error) {
	return expr{}, invalid(at, "only a computed layout row reads a subtotal")
}

func (lc *levelCtx) aggregate(op Aggregate, arg *Node, scale int, at string) (expr, error) {
	inner := &rowsCtx{r: lc.lv.r, inAggregate: true, visiting: lc.visiting}
	e, err := compileFormula(inner, arg, at+".args.0")
	if err != nil {
		return expr{}, err
	}
	if err := checkAggregate(op, e.typ, scale, at+".args.0"); err != nil {
		return expr{}, err
	}
	name := fmt.Sprintf("y%d", len(lc.lv.aggs))
	return expr{sql: lc.lv.agg(name, aggregateSQL(op, e.sql, scale)), typ: aggregateType(op, e.typ, scale)}, nil
}

func (lc *levelCtx) window(op string, arg *Node, scale int, at string) (expr, error) {
	e, err := compileFormula(lc, arg, at+".args.0")
	if err != nil {
		return expr{}, err
	}
	return windowSQL(op, e, scale, lc.lv.frame, at)
}

func (lc *levelCtx) exists(n *Node, at string) (expr, error) {
	return expr{}, invalid(at, n.Op+" belongs in the filter")
}

func (lc *levelCtx) bind(v any) string   { return lc.lv.r.s.bind(v) }
func (lc *levelCtx) fiscalStart() string { return lc.bind(int64(lc.lv.c.fiscal)) }
func (lc *levelCtx) filter() bool        { return false }
```

- [ ] **Step 4: Write `Run` and the assembly**

`$WS/tinycld/core/server/reports/run.go`:

```go
package reports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/changesignal"
)

// Options shape one run without changing the report.
type Options struct {
	// Expand lists the group keys (a group row's groupKey) whose children
	// the result includes. Groups load lazily: a run returns the first
	// level and the children of each expanded group.
	Expand    [][]any `json:"expand,omitempty"`
	ExpandAll bool    `json:"expandAll,omitempty"`
	// Cursor is the previous page's page.next; Limit is the page size of a
	// report without groups.
	Cursor string `json:"cursor,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	// Today is the reader's day (YYYY-MM-DD) for period presets; the
	// default is today in UTC.
	Today string `json:"today,omitempty"`
	// Display holds the shell's display options (number format, hidden
	// columns). The server does not read them: formatting stays in the
	// client.
	Display json.RawMessage `json:"display,omitempty"`
}

// Request is one run: a loaded spec, the reader, and the run's inputs.
type Request struct {
	Spec    *Spec
	Loaded  *LoadInfo
	Params  map[string]json.RawMessage
	Options Options
	// Auth is the reader. Every collection the report reads is filtered by
	// the reader's list rule.
	Auth *core.Record
	// Headers are the request's headers as a rule's @request.headers sees
	// them.
	Headers map[string]string
}

// Result is the run's answer, in the shell's ReportModel row shape.
type Result struct {
	Columns []ResultColumn `json:"columns"`
	Rows    []Row          `json:"rows"`
	Notices []Notice       `json:"notices"`
	Topics  []string       `json:"topics"`
	Page    *Page          `json:"page"`
}

type ResultColumn struct {
	ID    string    `json:"id"`
	Label string    `json:"label"`
	Type  FieldType `json:"type"`
	// TotalType is the type of the column's group, subtotal and total
	// cells when it differs from Type (a count of names is a number).
	TotalType FieldType `json:"totalType,omitempty"`
	Aggregate Aggregate `json:"aggregate,omitempty"`
	Format    string    `json:"format,omitempty"`
	Options   []Option  `json:"options,omitempty"`
	// Currency is a money column's fixed currency; CurrencyCell names the
	// cell that holds each row's currency instead.
	Currency      string       `json:"currency,omitempty"`
	CurrencyCell  string       `json:"currencyCell,omitempty"`
	MixedCurrency bool         `json:"mixedCurrency,omitempty"`
	Pivot         *PivotColumn `json:"pivot,omitempty"`
}

// PivotColumn marks a pivot cell column: the cell column it splits, and
// the pivot value it holds.
type PivotColumn struct {
	Cell string `json:"cell"`
	Key  any    `json:"key"`
}

// Row kinds.
const (
	KindDetail   = "detail"
	KindGroup    = "group"
	KindSubtotal = "subtotal"
	KindComputed = "computed"
	KindTotal    = "total"
)

type Row struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Depth int    `json:"depth"`
	Label string `json:"label"`
	// Section is the group row this row belongs to.
	Section string `json:"section,omitempty"`
	// Parent is the row a nested child row hangs under.
	Parent   string         `json:"parent,omitempty"`
	GroupKey []any          `json:"groupKey,omitempty"`
	Expanded bool           `json:"expanded,omitempty"`
	Cells    map[string]any `json:"cells"`
}

type Notice struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Columns []string `json:"columns,omitempty"`
	Count   int      `json:"count,omitempty"`
	Aliases []Alias  `json:"aliases,omitempty"`
}

type Page struct {
	Next string `json:"next,omitempty"`
	Size int    `json:"size"`
}

var (
	// ErrTimeout is a statement stopped at the time limit.
	ErrTimeout = errors.New("reports: the report took too long to run")
	// ErrAmountTooLarge is a total past the largest integer SQLite holds.
	ErrAmountTooLarge = errors.New("reports: an amount is too large to total")
	// ErrNoReader is a run without a signed-in user: a report never runs
	// as a superuser or as nobody.
	ErrNoReader = errors.New("reports: a report runs as a signed-in user")
)

type limits struct {
	timeout  time.Duration
	rowCap   int
	pageSize int
	maxPage  int
}

// runLimits: each statement stops after timeout; group, pivot and nested
// results stop at rowCap rows; a detail page holds pageSize rows unless
// the run asks for up to maxPage.
var runLimits = limits{timeout: 10 * time.Second, rowCap: 5000, pageSize: 200, maxPage: 1000}

const blankLabel = "(none)"

// runner holds one run's state.
type runner struct {
	ctx    context.Context
	app    core.App
	c      *compiler
	opts   Options
	expand *expansion
	res    *Result
	topics map[string]bool
}

// Run runs a report for its reader. The statements read only rows the
// reader's list rules allow; they never write.
func Run(ctx context.Context, app core.App, req Request) (*Result, error) {
	if req.Auth == nil || req.Auth.IsSuperuser() {
		return nil, ErrNoReader
	}
	p, specErr := bind(req.Spec)
	if specErr != nil {
		return nil, specErr
	}
	today, err := todayOf(req.Options.Today)
	if err != nil {
		return nil, err
	}
	params, specErr := resolveParams(p.spec.Params, req.Params, periodContext{today: today, fiscalStart: fiscalStartOf(p.base, app)})
	if specErr != nil {
		return nil, specErr
	}
	c := newCompiler(p, app, listRequestInfo(req.Auth, req.Headers), params)
	expand, err := parseExpansion(req.Options)
	if err != nil {
		return nil, err
	}
	rn := &runner{
		ctx: ctx, app: app, c: c, opts: req.Options, expand: expand,
		res:    &Result{Rows: []Row{}, Notices: []Notice{}},
		topics: map[string]bool{},
	}
	if req.Loaded != nil {
		rn.loadNotices(req.Loaded)
	}
	if err := rn.run(); err != nil {
		return nil, err
	}
	return rn.res, nil
}

func todayOf(s string) (time.Time, error) {
	if s == "" {
		return time.Now().UTC().Truncate(24 * time.Hour), nil
	}
	if !isDay(s) {
		return time.Time{}, invalid("options.today", "today is YYYY-MM-DD")
	}
	return time.Parse(time.DateOnly, s)
}

func (rn *runner) loadNotices(info *LoadInfo) {
	if info.UpgradedFrom != 0 {
		rn.notice(Notice{Code: "upgraded", Message: fmt.Sprintf("The report was made with spec version %d and upgraded.", info.UpgradedFrom), Count: info.UpgradedFrom})
	}
	if len(info.Aliased) > 0 {
		rn.notice(Notice{Code: "aliased", Message: "Some fields of the report were renamed; it uses their new names.", Aliases: info.Aliased})
	}
}

func (rn *runner) notice(n Notice) { rn.res.Notices = append(rn.res.Notices, n) }

func (rn *runner) run() error {
	groupRows, err := rn.groupPass()
	if err != nil {
		return err
	}
	var details []map[string]any
	if len(rn.c.p.groups) == 0 || len(rn.expand.keys) > 0 || rn.expand.all {
		details, err = rn.detailPass()
		if err != nil {
			return err
		}
	}
	rn.res.Columns = rn.columns()
	rn.markCurrencies(groupRows)
	rn.assemble(groupRows, details)
	rn.res.Topics = make([]string, 0, len(rn.topics))
	for t := range rn.topics {
		rn.res.Topics = append(rn.res.Topics, t)
	}
	slices.Sort(rn.res.Topics)
	return nil
}

// query runs one statement under the time limit and records the topics of
// every collection it reads.
func (rn *runner) query(s *stmt, ctes []string, body string) ([]map[string]any, error) {
	with, err := s.with(ctes...)
	if err != nil {
		return nil, err
	}
	sql := with + body
	topics, err := changesignal.TopicsRead(rn.app, sql, s.params)
	if err != nil {
		return nil, mapRunError(err)
	}
	for _, t := range topics {
		rn.topics[t] = true
	}
	ctx, cancel := context.WithTimeout(rn.ctx, runLimits.timeout)
	defer cancel()
	rows, err := rn.app.DB().NewQuery(sql).Bind(s.params).WithContext(ctx).Rows()
	if err != nil {
		return nil, mapRunError(err)
	}
	out, err := scanRows(rows)
	if err != nil {
		return nil, mapRunError(err)
	}
	return out, nil
}

func mapRunError(err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return ErrTimeout
	case strings.Contains(err.Error(), "integer overflow"):
		return ErrAmountTooLarge
	}
	return err
}

// groupPass runs the group statement: every group level and the total,
// capped at rowCap rows.
func (rn *runner) groupPass() ([]map[string]any, error) {
	c := rn.c
	s := newStmt(rn.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	ctes, body, err := c.groupStatement(s, r, rn.expand)
	if err != nil {
		return nil, err
	}
	rows, err := rn.query(s, append([]string{r.render()}, ctes...), body+" LIMIT "+s.bind(int64(runLimits.rowCap+1)))
	if err != nil {
		return nil, err
	}
	if len(rows) > runLimits.rowCap {
		rows = rows[:runLimits.rowCap]
		rn.notice(Notice{Code: "rowCap", Message: fmt.Sprintf("The report shows its first %d rows.", runLimits.rowCap), Count: runLimits.rowCap})
	}
	return rows, nil
}

// groupStatement is the UNION ALL of every level's rows (the children of
// expanded groups only).
func (c *compiler) groupStatement(s *stmt, r *rowsCTE, expand *expansion) ([]string, string, error) {
	var ctes, legs []string
	c.levelTypes = map[string]FieldType{}
	for n := 0; n <= len(c.p.groups); n++ {
		lv, err := c.level(r, n)
		if err != nil {
			return nil, "", err
		}
		cells := make([]string, 0, len(c.p.cols))
		for idx, cp := range c.p.cols {
			e, err := lv.cell(cp)
			if err != nil {
				return nil, "", err
			}
			cells = append(cells, fmt.Sprintf("%s AS v%d", e.sql, idx))
			c.levelTypes[cp.col.ID] = e.typ
		}
		ctes = append(ctes, lv.render(cells)...)
		leg := fmt.Sprintf("SELECT * FROM o%d", n)
		if n >= 2 {
			leg += " WHERE " + expand.where(c, s, n-1, "")
		}
		legs = append(legs, leg)
	}
	return ctes, strings.Join(legs, "\nUNION ALL\n") + "\nORDER BY __level, __ord", nil
}

// detailPass runs the detail statement: one row per base row (up to the
// row cap without groups), or the rows of the expanded innermost groups.
func (rn *runner) detailPass() ([]map[string]any, error) {
	c := rn.c
	s := newStmt(rn.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	sel, order, err := c.detailSelect(r)
	if err != nil {
		return nil, err
	}
	where := "1"
	limit := runLimits.rowCap
	if len(c.p.groups) > 0 {
		where = rn.expand.where(c, s, len(c.p.groups), "d.")
	}
	body := fmt.Sprintf("SELECT * FROM (%s) d WHERE %s ORDER BY %s LIMIT %s",
		sel, where, orderBy(order), s.bind(int64(limit+1)))
	rows, err := rn.query(s, []string{r.render()}, body)
	if err != nil {
		return nil, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		rn.notice(Notice{Code: "rowCap", Message: fmt.Sprintf("The report shows its first %d rows.", runLimits.rowCap), Count: runLimits.rowCap})
	}
	return rows, nil
}

// detailSelect is the select of detail rows over w and their sort keys.
func (c *compiler) detailSelect(r *rowsCTE) (string, []sortKey, error) {
	keys := make([]string, 0)
	for i := range c.p.groups {
		keys = append(keys, fmt.Sprintf("w.k%d", i))
	}
	frame := &windowFrame{
		parent: append(prefixed("w.", c.currencies), keys...),
		total:  prefixed("w.", c.currencies),
	}
	visiting := map[string]bool{}
	var order []sortKey
	sel := []string{"w.__id AS __id"}
	for _, k := range append(keys, prefixed("w.", c.currencies)...) {
		sel = append(sel, k+" AS "+strings.TrimPrefix(k, "w."))
	}
	for i, s := range c.p.sort {
		ctx := &rowsCtx{r: r, visiting: visiting, detail: frame}
		e, err := ctx.col(s.col.col.ID, fmt.Sprintf("sort.%d.col", i))
		if err != nil {
			return "", nil, err
		}
		if e.win {
			return "", nil, invalid(fmt.Sprintf("sort.%d.col", i), "a running value or a percent is not a sort key")
		}
		name := fmt.Sprintf("s%d", i)
		sel = append(sel, e.sql+" AS "+name)
		order = append(order, sortKey{name: name, desc: s.desc})
		frame.order = append(frame.order, "("+e.sql+" IS NULL)", e.sql+dirOf(s.desc))
	}
	frame.order = append(frame.order, "w.__id")
	order = append(order, sortKey{name: "__id"})
	c.detailTypes = map[string]FieldType{}
	for idx, cp := range c.p.cols {
		if cp.nest > 0 {
			sel = append(sel, fmt.Sprintf("NULL AS v%d", idx))
			c.detailTypes[cp.col.ID] = cp.path.field.Type
			continue
		}
		ctx := &rowsCtx{r: r, visiting: visiting, detail: frame}
		e, err := ctx.col(cp.col.ID, cp.at)
		if err != nil {
			return "", nil, err
		}
		sel = append(sel, fmt.Sprintf("%s AS v%d", e.sql, idx))
		c.detailTypes[cp.col.ID] = e.typ
	}
	return "SELECT " + strings.Join(sel, ", ") + " FROM w", order, nil
}

// sortKey is one ORDER BY column of the detail select: s<i> for a sort
// column, then __id, which is unique and never NULL.
type sortKey struct {
	name string
	desc bool
}

// orderBy sorts detail rows with NULLs last in either direction.
func orderBy(keys []sortKey) string {
	parts := make([]string, 0, 2*len(keys))
	for _, k := range keys {
		col := "d." + k.name
		if k.name != "__id" {
			parts = append(parts, "("+col+" IS NULL)")
		}
		parts = append(parts, col+dirOf(k.desc))
	}
	return strings.Join(parts, ", ")
}

func dirOf(desc bool) string {
	if desc {
		return " DESC"
	}
	return ""
}

// expansion is the set of group keys whose children a run includes.
type expansion struct {
	all  bool
	keys [][]any
}

func parseExpansion(opts Options) (*expansion, error) {
	e := &expansion{all: opts.ExpandAll}
	for i, key := range opts.Expand {
		if len(key) == 0 {
			return nil, invalid(fmt.Sprintf("options.expand.%d", i), "a group key is a group row's groupKey")
		}
		norm := make([]any, len(key))
		for j, v := range key {
			switch x := v.(type) {
			case nil, string, bool:
				norm[j] = x
			case float64:
				if x == float64(int64(x)) {
					norm[j] = int64(x)
				} else {
					norm[j] = x
				}
			case json.Number:
				norm[j] = numberValue(x)
			default:
				return nil, invalid(fmt.Sprintf("options.expand.%d", i), "a group key holds text, numbers, true, false or null")
			}
		}
		e.keys = append(e.keys, norm)
	}
	return e, nil
}

// where matches rows whose first depth group keys and currency keys equal
// an expanded group key.
func (e *expansion) where(c *compiler, s *stmt, depth int, prefix string) string {
	if e.all {
		return "1"
	}
	var ors []string
	for _, key := range e.keys {
		if len(key) != depth+len(c.currencies) {
			continue
		}
		conds := []string{"1"}
		for i := range depth {
			conds = append(conds, fmt.Sprintf("%sk%d IS %s", prefix, i, s.bind(key[i])))
		}
		for j, ck := range c.currencies {
			conds = append(conds, fmt.Sprintf("%s%s IS %s", prefix, ck, s.bind(key[depth+j])))
		}
		ors = append(ors, "("+strings.Join(conds, " AND ")+")")
	}
	if len(ors) == 0 {
		return "0"
	}
	return "(" + strings.Join(ors, " OR ") + ")"
}

func (e *expansion) has(key []any) bool {
	if e.all {
		return true
	}
	return slices.ContainsFunc(e.keys, func(k []any) bool { return sameKey(k, key) })
}

func sameKey(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if fmt.Sprint(a[i]) != fmt.Sprint(b[i]) {
			return false
		}
	}
	return true
}

// compileDry compiles every statement of a plan without a database, so a
// formula, a filter or a layout that cannot compile fails Validate, not a
// run. Params are unset.
func compileDry(p *plan) error {
	c := newCompiler(p, nil, nil, nil)
	s := newStmt(nil, nil)
	r, err := c.rows(s)
	if err != nil {
		return err
	}
	if _, _, err := c.detailSelect(r); err != nil {
		return err
	}
	_, _, err = c.groupStatement(s, r, &expansion{})
	return err
}
```

`$WS/tinycld/core/server/reports/assemble.go`:

```go
package reports

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// columns describes the result's columns.
func (rn *runner) columns() []ResultColumn {
	c := rn.c
	out := make([]ResultColumn, 0, len(c.p.cols))
	for _, cp := range c.p.cols {
		rc := ResultColumn{ID: cp.col.ID, Label: labelOf(cp), Aggregate: cp.col.Aggregate, Format: cp.col.Format}
		rc.Type = c.detailTypes[cp.col.ID]
		if rc.Type == "" {
			rc.Type = c.levelTypes[cp.col.ID]
		}
		if cp.path != nil {
			rc.Type = cp.path.field.Type
			if cp.tm >= 0 {
				rc.Type = aggregateType(cp.col.Aggregate, cp.path.field.Type, cp.scale)
			}
			if cp.path.field.Type == Select {
				rc.Options = cp.path.field.Options
			}
		}
		if t := c.levelTypes[cp.col.ID]; t != "" && t != rc.Type && cp.col.Aggregate != "" {
			rc.TotalType = t
		}
		rn.currencyOfColumn(cp, &rc)
		out = append(out, rc)
	}
	return out
}

func (rn *runner) currencyOfColumn(cp *colPlan, rc *ResultColumn) {
	if _, ok := rn.c.currencyOf[cp.col.ID]; ok {
		rc.CurrencyCell = cp.col.ID + "@currency"
		return
	}
	if cp.path != nil && cp.path.field.Type == Money && cp.path.src.Currency != nil {
		rc.Currency = cp.path.src.Currency(rn.app)
	}
}

func labelOf(cp *colPlan) string {
	switch {
	case cp.col.Label != "":
		return cp.col.Label
	case cp.path != nil:
		return cp.path.field.Label
	}
	return cp.col.ID
}

// markCurrencies marks every money column whose total rows hold more than
// one currency, and says so in a notice.
func (rn *runner) markCurrencies(groupRows []map[string]any) {
	mixed := map[string]bool{}
	for _, ck := range rn.c.currencies {
		seen := map[string]bool{}
		for _, row := range groupRows {
			if toInt(row["__level"]) == 0 && row[ck] != nil {
				seen[fmt.Sprint(row[ck])] = true
			}
		}
		mixed[ck] = len(seen) > 1
	}
	var cols []string
	for i := range rn.res.Columns {
		rc := &rn.res.Columns[i]
		id := rc.ID
		if rc.Pivot != nil {
			id = rc.Pivot.Cell
		}
		if ck, ok := rn.c.currencyOf[id]; ok && mixed[ck] {
			rc.MixedCurrency = true
			cols = append(cols, rc.ID)
		}
	}
	if len(cols) > 0 {
		rn.notice(Notice{Code: "mixedCurrency", Message: "Amounts in different currencies are totalled apart, one row per currency.", Columns: cols})
	}
}

func toInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	}
	return 0
}

// tree indexes the group statement's rows for assembly.
type tree struct {
	children map[string][]map[string]any // by parent key, in order
	totals   []map[string]any
	details  map[string][]map[string]any
}

func keyString(key []any) string {
	b, _ := json.Marshal(key)
	return string(b)
}

// rowKey is a level-n row's group key: its n group keys, then its
// currency keys.
func (rn *runner) rowKey(row map[string]any, n int) []any {
	key := make([]any, 0, n+len(rn.c.currencies))
	for i := range n {
		key = append(key, row[fmt.Sprintf("k%d", i)])
	}
	for _, ck := range rn.c.currencies {
		key = append(key, row[ck])
	}
	return key
}

func (rn *runner) currencyKey(row map[string]any) string { return keyString(rn.rowKey(row, 0)) }

func (rn *runner) assemble(groupRows, details []map[string]any) {
	t := &tree{children: map[string][]map[string]any{}, details: map[string][]map[string]any{}}
	for _, row := range groupRows {
		n := int(toInt(row["__level"]))
		switch {
		case n == 0:
			t.totals = append(t.totals, row)
		default:
			parent := keyString(rn.rowKey(row, n-1))
			t.children[parent] = append(t.children[parent], row)
		}
	}
	groups := len(rn.c.p.groups)
	for _, row := range details {
		key := keyString(rn.rowKey(row, groups))
		t.details[key] = append(t.details[key], row)
	}
	// One total per currency, in currency order.
	sort.SliceStable(t.totals, func(i, j int) bool {
		return rn.currencyKey(t.totals[i]) < rn.currencyKey(t.totals[j])
	})
	if len(t.totals) == 0 {
		// A total over no rows grouped by currency has no row; the report
		// still ends in a total.
		t.totals = []map[string]any{{"__level": int64(0)}}
	}
	if groups == 0 {
		for _, row := range details {
			rn.detail(t, row, "", 0)
		}
	}
	for _, total := range t.totals {
		for _, g := range t.children[rn.currencyKey(total)] {
			rn.group(t, g, 1, "")
		}
		rn.push(Row{ID: "total" + rn.currencySuffix(total), Kind: KindTotal, Label: "Total", Cells: rn.cells(total)})
	}
}

func (rn *runner) currencySuffix(row map[string]any) string {
	if len(rn.c.currencies) == 0 {
		return ""
	}
	return ":" + rn.currencyKey(row)
}

func (rn *runner) push(row Row) { rn.res.Rows = append(rn.res.Rows, row) }

// group emits a level-n group row, its children when expanded, and its
// subtotal.
func (rn *runner) group(t *tree, row map[string]any, n int, section string) {
	p := rn.c.p
	key := rn.rowKey(row, n)
	id := "g:" + keyString(key)
	label := rn.display(p.groups[n-1].col, row[fmt.Sprintf("k%d", n-1)], p.groups[n-1].group.Bucket != "")
	rn.groupWithLabel(t, row, n, section, id, label, key, p.groups[n-1].group.Subtotals)
}

// groupWithLabel emits a group row; subtotal says whether an expanded group
// ends in a subtotal row.
func (rn *runner) groupWithLabel(t *tree, row map[string]any, n int, section, id, label string, key []any, subtotal bool) {
	p := rn.c.p
	canOpen := n < len(p.groups) || p.pivot == nil
	expanded := canOpen && rn.expand.has(key)
	rn.push(Row{ID: id, Kind: KindGroup, Depth: n - 1, Label: label, Section: section, GroupKey: key, Expanded: expanded, Cells: rn.cells(row)})
	if expanded {
		if n < len(p.groups) {
			for _, child := range t.children[keyString(key)] {
				rn.group(t, child, n+1, id)
			}
		} else {
			for _, d := range t.details[keyString(key)] {
				rn.detail(t, d, id, n)
			}
		}
	}
	if subtotal && expanded {
		rn.push(Row{ID: "s:" + keyString(key), Kind: KindSubtotal, Depth: n - 1, Label: "Total " + label, Section: id, GroupKey: key, Cells: rn.cells(row)})
	}
}

// detail emits a detail row.
func (rn *runner) detail(t *tree, row map[string]any, section string, depth int) {
	id := fmt.Sprintf("d:%v", row["__id"])
	rn.push(Row{ID: id, Kind: KindDetail, Depth: depth, Label: rn.firstLabel(rn.c.p.cols, row), Section: section, Cells: rn.cells(row)})
}

// cells maps a statement row's v<idx> values to column ids, with each
// money column's currency.
func (rn *runner) cells(row map[string]any) map[string]any {
	out := map[string]any{}
	for idx, cp := range rn.c.p.cols {
		name := fmt.Sprintf("v%d", idx)
		if _, ok := row[name]; !ok {
			continue
		}
		out[cp.col.ID] = rn.cellValue(cp, row[name])
		if ck, ok := rn.c.currencyOf[cp.col.ID]; ok {
			out[cp.col.ID+"@currency"] = row[ck]
		}
	}
	return out
}

func (rn *runner) cellValue(cp *colPlan, v any) any {
	if v != nil && rn.typeOf(cp) == Bool {
		return toInt(v) != 0
	}
	return v
}

func (rn *runner) typeOf(cp *colPlan) FieldType {
	if t := rn.c.detailTypes[cp.col.ID]; t != "" {
		return t
	}
	return rn.c.levelTypes[cp.col.ID]
}

func (rn *runner) firstLabel(cols []*colPlan, row map[string]any) string {
	if len(cols) == 0 {
		return ""
	}
	idx := rn.c.p.index(cols[0])
	return rn.display(cols[0], row[fmt.Sprintf("v%d", idx)], false)
}

// display is a value as a row label: a select's label, Yes or No, the
// number or text itself, or (none) for a blank.
func (rn *runner) display(cp *colPlan, v any, bucketed bool) string {
	if v == nil || v == "" {
		return blankLabel
	}
	if !bucketed && cp.path != nil {
		switch cp.path.field.Type {
		case Select:
			for _, o := range cp.path.field.Options {
				if o.Value == v {
					return o.Label
				}
			}
		case Bool:
			if toInt(v) != 0 {
				return "Yes"
			}
			return "No"
		}
	}
	switch x := v.(type) {
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case string:
		return x
	}
	return strings.TrimSpace(fmt.Sprint(v))
}
```

- [ ] **Step 5: Let `Validate` compile the spec**

In `$WS/tinycld/core/server/reports/bind.go`, replace:

```go
	_, err := bind(spec)
	if err != nil {
		return err
	}
	return nil
}
```

with:

```go
	p, err := bind(spec)
	if err != nil {
		return err
	}
	return compileDry(p)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports` (the Task 8 tests still pass: the design example compiles).

- [ ] **Step 7: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/detail.go \
  core/server/reports/levels.go \
  core/server/reports/run.go \
  core/server/reports/assemble.go \
  core/server/reports/bind.go \
  core/server/reports/run_test.go \
  core/server/reports/groups_test.go
git commit -m "feat(core): run a report: detail rows, lazy groups, subtotals, totals and running values"
```

---

### Task 11: Keyset paging of detail rows

**Files:**
- Create: `$WS/tinycld/core/server/reports/paging.go`
- Modify: `$WS/tinycld/core/server/reports/run.go` (`detailPass`)
- Test: `$WS/tinycld/core/server/reports/paging_test.go`

A page starts after the last row of the page before: the cursor holds that row's sort values and its id (unique, never NULL), base64url JSON. NULLs sort last in either direction, so after a NULL come only NULLs. Every page ends in the total of every row; a running sum runs over every row (windows are computed before the cursor filter, Task 10).

**Interfaces:**
- Consumes: `sortKey`, `orderBy`, `numberValue`, `invalid`, `runLimits`, `Page`.
- Produces: `func cursorOf(keys []sortKey, row map[string]any) string`; `func keysetAfter(s *stmt, keys []sortKey, cursor string) (string, error)` (400 at `options.cursor` for a cursor the report did not give). A report without groups sets `Result.Page` (`size`, and `next` when more rows follow); `options.limit` asks for up to `maxPage` rows.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/paging_test.go`:

```go
package reports

import (
	"testing"
)

const feedingsPaged = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"note","path":[{"field":"note"}]},
	{"id":"fed","path":[{"field":"fed"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
	{"id":"running","formula":{"op":"runningSum","args":[{"col":"cost"}]}}],
	"sort":[{"col":"fed","dir":"desc"}]}`

func TestDetailRowsPageByKeyset(t *testing.T) {
	z := newZoo(t)
	// A feeding with no date sorts last, in either direction.
	z.rec(t, "f8", "zoo_feedings", map[string]any{"animal": z.id("leo"), "cost": 50, "currency": "USD", "note": "f8"})

	first := z.run(t, "ann", feedingsPaged, Options{Limit: 2}, nil)
	requireRows(t, first, "note", "f4", "f2", nil)
	if first.Page == nil || first.Page.Size != 2 || first.Page.Next == "" {
		t.Fatalf("page = %+v", first.Page)
	}
	// Every page ends in the total of every row, not of the page.
	requireRows(t, first, "cost", int64(300), int64(2500), int64(4550))

	second := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: first.Page.Next}, nil)
	requireRows(t, second, "note", "f3", "f1", nil)
	// A running sum runs over every row, across pages.
	requireRows(t, second, "running", int64(3500), int64(4500), int64(4550))

	third := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: second.Page.Next}, nil)
	requireRows(t, third, "note", "f8", nil)
	if third.Page.Next != "" {
		t.Fatalf("the last page has a next cursor: %+v", third.Page)
	}
}

func TestAPageStartsAfterItsCursorWhenRowsChange(t *testing.T) {
	z := newZoo(t)
	first := z.run(t, "ann", feedingsPaged, Options{Limit: 2}, nil)
	// A row added before the cursor's place does not shift the next page.
	z.feeding(t, "f9", z.recs["leo"], 10, "2026-03-31", 1)
	second := z.run(t, "ann", feedingsPaged, Options{Limit: 2, Cursor: first.Page.Next}, nil)
	requireRows(t, second, "note", "f3", "f1", nil)
}

func TestACursorThisReportDidNotGiveIsRefused(t *testing.T) {
	z := newZoo(t)
	for _, cursor := range []string{"not base64!", "WyJ4Il0", "W3siYSI6MX0sImlkIl0"} {
		_, err := z.try(t, "ann", feedingsPaged, Options{Cursor: cursor}, nil)
		requireSpecError(t, err, 400, "options.cursor", "not one this report gave")
	}
}

func TestAPageHoldsAtMostTheLargestPage(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.maxPage = 3 })
	res := z.run(t, "ann", feedingsPaged, Options{Limit: 50}, nil)
	if res.Page.Size != 3 || res.Page.Next == "" {
		t.Fatalf("page = %+v", res.Page)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL: `TestDetailRowsPageByKeyset`: `note = [f4 f2 f3 f1 f8 <nil>]`, want `[f4 f2 <nil>]` (no paging yet), and the other paging tests.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/paging.go`:

```go
package reports

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
)

// cursorOf is the page cursor after row: its sort values, then its id.
func cursorOf(keys []sortKey, row map[string]any) string {
	values := make([]any, len(keys))
	for i, k := range keys {
		values[i] = row[k.name]
	}
	b, _ := json.Marshal(values)
	return base64.RawURLEncoding.EncodeToString(b)
}

// keysetAfter selects the rows after a cursor in the detail order: a page
// starts where the last one ended, so a row added or removed between pages
// does not shift the rest. The cursor's values are bound, never inlined.
func keysetAfter(s *stmt, keys []sortKey, cursor string) (string, error) {
	if cursor == "" {
		return "1", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", invalid("options.cursor", "the cursor is not one this report gave")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var values []any
	if err := dec.Decode(&values); err != nil || len(values) != len(keys) || values[len(values)-1] == nil {
		return "", invalid("options.cursor", "the cursor is not one this report gave")
	}
	for i, v := range values {
		switch x := v.(type) {
		case json.Number:
			values[i] = numberValue(x)
		case nil, string, bool:
		default:
			return "", invalid("options.cursor", "the cursor is not one this report gave")
		}
	}
	last := len(keys) - 1
	cond := "d.__id > " + s.bind(values[last])
	for i := last - 1; i >= 0; i-- {
		col := "d." + keys[i].name
		if values[i] == nil {
			// NULLs sort last, so after a NULL come only NULLs.
			cond = "(" + col + " IS NULL AND " + cond + ")"
			continue
		}
		cmp := " > "
		if keys[i].desc {
			cmp = " < "
		}
		v := s.bind(values[i])
		cond = "(" + col + " IS NULL OR " + col + cmp + v + " OR (" + col + " = " + v + " AND " + cond + "))"
	}
	return cond, nil
}
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
// detailPass runs the detail statement: one row per base row (up to the
// row cap without groups), or the rows of the expanded innermost groups.
func (rn *runner) detailPass() ([]map[string]any, error) {
	c := rn.c
	s := newStmt(rn.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	sel, order, err := c.detailSelect(r)
	if err != nil {
		return nil, err
	}
	where := "1"
	limit := runLimits.rowCap
	if len(c.p.groups) > 0 {
		where = rn.expand.where(c, s, len(c.p.groups), "d.")
	}
	body := fmt.Sprintf("SELECT * FROM (%s) d WHERE %s ORDER BY %s LIMIT %s",
		sel, where, orderBy(order), s.bind(int64(limit+1)))
	rows, err := rn.query(s, []string{r.render()}, body)
	if err != nil {
		return nil, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		rn.notice(Notice{Code: "rowCap", Message: fmt.Sprintf("The report shows its first %d rows.", runLimits.rowCap), Count: runLimits.rowCap})
	}
	return rows, nil
}
```

with:

```go
// detailPass runs the detail statement: one row per base row, a page at a
// time without groups, or the rows of the expanded innermost groups.
func (rn *runner) detailPass() ([]map[string]any, error) {
	c := rn.c
	s := newStmt(rn.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	sel, order, err := c.detailSelect(r)
	if err != nil {
		return nil, err
	}
	where := "1"
	limit := runLimits.rowCap
	paged := len(c.p.groups) == 0
	if paged {
		limit = runLimits.pageSize
		if rn.opts.Limit > 0 {
			limit = min(rn.opts.Limit, runLimits.maxPage)
		}
		where, err = keysetAfter(s, order, rn.opts.Cursor)
		if err != nil {
			return nil, err
		}
	} else {
		where = rn.expand.where(c, s, len(c.p.groups), "d.")
	}
	body := fmt.Sprintf("SELECT * FROM (%s) d WHERE %s ORDER BY %s LIMIT %s",
		sel, where, orderBy(order), s.bind(int64(limit+1)))
	rows, err := rn.query(s, []string{r.render()}, body)
	if err != nil {
		return nil, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	if paged {
		rn.res.Page = &Page{Size: len(rows)}
		if more {
			rn.res.Page.Next = cursorOf(order, rows[len(rows)-1])
		}
	} else if more {
		rn.notice(Notice{Code: "rowCap", Message: fmt.Sprintf("The report shows its first %d rows.", runLimits.rowCap), Count: runLimits.rowCap})
	}
	return rows, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/paging.go \
  core/server/reports/run.go \
  core/server/reports/paging_test.go
git commit -m "feat(core): keyset paging of report detail rows"
```

---

### Task 12: Pivot

**Files:**
- Create: `$WS/tinycld/core/server/reports/pivot.go`
- Modify: `$WS/tinycld/core/server/reports/rows.go`, `run.go`, `assemble.go`
- Test: `$WS/tinycld/core/server/reports/pivot_test.go`

The pivot's first pass reads `SELECT pk, COUNT(*) OVER () AS __n FROM (SELECT DISTINCT pk FROM w) ORDER BY (pk IS NULL), pk LIMIT maxColumns + 1`; `__n` says how many values exist, so the notice can say how many are left out. The main pass adds, per value, the cell column's aggregate over `CASE WHEN w.pk IS <value> THEN <cell> END`. The row cap applies to the group statement only, after the pivot pass. Pivot cell columns are `<cell>.p<j>`, labelled with the value, with `pivot: {cell, key}`.

**Interfaces:**
- Consumes: `level.agg`, `aggregateSQL`, `checkAggregate`, `bucketSQL`, `rowsCtx`, `runner.query`.
- Produces: `(*rowsCTE).pivotKey()` (adds `pk` to `w`); `(*runner).pivotPass() ([]any, error)`; `(*compiler).pivotCells(lv *level, values []any) ([]string, error)` (`pv<j>` cells); `(*level).cellArg(cp) (string, FieldType, error)`; `(*runner).pivotLabel(key any) string`; `runner.pivotValues`; `groupStatement(s, r, expand, pivot []any)`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/pivot_test.go`:

```go
package reports

import (
	"reflect"
	"testing"
)

const costBySpeciesAndMonth = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
	"groups":[{"id":"g","col":"species"}],
	"pivot":{"path":[{"field":"fed"}],"bucket":"month","cell":"cost"%s}}`

func pivotIDs(res *Result) []string {
	var ids []string
	for _, c := range res.Columns {
		if c.Pivot != nil {
			ids = append(ids, c.ID+"="+c.Label)
		}
	}
	return ids
}

func TestPivotSplitsTheCellByValue(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sprintf(costBySpeciesAndMonth, ""), Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"cost.p0=2026-01", "cost.p1=2026-02", "cost.p2=2026-03"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	if c := res.Columns[2]; c.Pivot.Cell != "cost" || c.Pivot.Key != "2026-01" || c.Type != Money || c.CurrencyCell != "cost@currency" {
		t.Fatalf("pivot column = %+v", c)
	}
	requireRows(t, res, "label", "lion", "zebra", "Total")
	requireRows(t, res, "cost.p0", int64(1000), int64(700), int64(1700))
	requireRows(t, res, "cost.p1", int64(2500), int64(0), int64(2500))
	requireRows(t, res, "cost.p2", int64(0), int64(300), int64(300))
	// The cell column itself stays as the row's total across the pivot.
	requireRows(t, res, "cost", int64(3500), int64(1000), int64(4500))
	if res.Rows[0].Expanded {
		t.Fatal("a pivot's innermost group has no detail rows to open")
	}
}

func TestPivotStopsAtMaxColumnsAndSaysHowManyAreLeftOut(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sprintf(costBySpeciesAndMonth, `,"maxColumns":2`), Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"cost.p0=2026-01", "cost.p1=2026-02"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	if len(res.Notices) != 1 || res.Notices[0].Code != "pivotCap" || res.Notices[0].Count != 1 {
		t.Fatalf("notices = %+v", res.Notices)
	}
}

func TestTheRowCapNeverCutsPivotColumns(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 1 })
	res := z.run(t, "ann", sprintf(costBySpeciesAndMonth, ""), Options{}, nil)
	if got := len(pivotIDs(res)); got != 3 {
		t.Fatalf("%d pivot columns, want 3", got)
	}
}

func TestPivotCellOfAnAverageAndAYearBucket(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "bob", `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"grams","path":[{"field":"grams"}],"aggregate":"avg","scale":1}],
		"groups":[{"id":"g","col":"species"}],
		"pivot":{"path":[{"field":"fed"}],"bucket":"year","cell":"grams"}}`, Options{}, nil)
	if got := pivotIDs(res); !reflect.DeepEqual(got, []string{"grams.p0=2026"}) {
		t.Fatalf("pivot columns = %v", got)
	}
	requireRows(t, res, "label", "monkey", "zebra", "Total")
	// Scale 1 keeps a decimal place, so every cell is a REAL.
	requireRows(t, res, "grams.p0", 50.0, 200.0, 150.0)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL: `TestPivotSplitsTheCellByValue`: `pivot columns = []`, and the other pivot tests.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/pivot.go`:

```go
package reports

import (
	"fmt"
)

// pivotKey puts the pivot value of each base row in w as pk.
func (r *rowsCTE) pivotKey() {
	pv := r.c.p.pivot
	if pv == nil {
		return
	}
	key := r.root.value(pv.path).sql
	if pv.pivot.Bucket != "" {
		key = bucketSQL(r.join(false), pv.pivot.Bucket, key)
	}
	r.add("pk", key)
}

// pivotPass is the pivot's first pass: its distinct values in order, at
// most maxColumns of them. The main pass's row cap never applies before
// it, so a pivot column never goes missing because of how many rows read
// it.
func (rn *runner) pivotPass() ([]any, error) {
	c := rn.c
	pv := c.p.pivot
	if pv == nil {
		return nil, nil
	}
	s := newStmt(rn.app, c.info)
	r, err := c.rows(s)
	if err != nil {
		return nil, err
	}
	body := fmt.Sprintf("SELECT pk, COUNT(*) OVER () AS __n FROM (SELECT DISTINCT pk FROM w) ORDER BY (pk IS NULL), pk LIMIT %s",
		s.bind(int64(pv.max+1)))
	rows, err := rn.query(s, []string{r.render()}, body)
	if err != nil {
		return nil, err
	}
	values := make([]any, 0, len(rows))
	for i, row := range rows {
		if i < pv.max {
			values = append(values, row["pk"])
		}
	}
	if len(rows) > pv.max {
		left := int(toInt(rows[0]["__n"])) - pv.max
		rn.notice(Notice{Code: "pivotCap", Message: fmt.Sprintf("The pivot shows its first %d columns; %d more are left out.", pv.max, left), Count: left})
	}
	rn.pivotValues = values
	return values, nil
}

// pivotCells adds one aggregate per pivot value to the level: the cell
// column's aggregate over the rows with that value.
func (c *compiler) pivotCells(lv *level, values []any) ([]string, error) {
	pv := c.p.pivot
	if pv == nil {
		return nil, nil
	}
	cell := pv.cell
	arg, typ, err := lv.cellArg(cell)
	if err != nil {
		return nil, err
	}
	if err := checkAggregate(cell.col.Aggregate, typ, cell.scale, "pivot.cell"); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(values))
	for j, v := range values {
		match := fmt.Sprintf("CASE WHEN w.pk IS %s THEN %s END", lv.r.s.bind(v), arg)
		ref := lv.agg(fmt.Sprintf("q%d", j), aggregateSQL(cell.col.Aggregate, match, cell.scale))
		out = append(out, fmt.Sprintf("%s AS pv%d", ref, j))
	}
	return out, nil
}

// cellArg is what a column with an aggregate aggregates, as a value of w.
func (lv *level) cellArg(cp *colPlan) (string, FieldType, error) {
	if cp.path != nil {
		return fmt.Sprintf("w.c%d", lv.c.p.index(cp)), cp.path.field.Type, nil
	}
	inner := &rowsCtx{r: lv.r, inAggregate: true, visiting: map[string]bool{}}
	e, err := compileFormula(inner, cp.col.Formula, cp.at+".formula")
	return e.sql, e.typ, err
}

// pivotLabel is a pivot value as a column label.
func (rn *runner) pivotLabel(key any) string {
	pv := rn.c.p.pivot
	return rn.display(&colPlan{col: &Column{}, path: pv.path}, key, pv.pivot.Bucket != "")
}
```

In `$WS/tinycld/core/server/reports/rows.go`, replace:

```go
			c.currencyOf[cp.col.ID] = name
		}
	}
	return r, nil
}
```

with:

```go
			c.currencyOf[cp.col.ID] = name
		}
	}
	r.pivotKey()
	return r, nil
}
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
	topics map[string]bool
}
```

with:

```go
	topics map[string]bool
	// pivotValues are the pivot's columns, from its first pass.
	pivotValues []any
}
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
	if len(rn.c.p.groups) == 0 || len(rn.expand.keys) > 0 || rn.expand.all {
```

with:

```go
	if rn.c.p.pivot == nil && (len(rn.c.p.groups) == 0 || len(rn.expand.keys) > 0 || rn.expand.all) {
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
	ctes, body, err := c.groupStatement(s, r, rn.expand)
```

with:

```go
	pivot, err := rn.pivotPass()
	if err != nil {
		return nil, err
	}
	ctes, body, err := c.groupStatement(s, r, rn.expand, pivot)
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
func (c *compiler) groupStatement(s *stmt, r *rowsCTE, expand *expansion) ([]string, string, error) {
```

with:

```go
func (c *compiler) groupStatement(s *stmt, r *rowsCTE, expand *expansion, pivot []any) ([]string, string, error) {
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
			c.levelTypes[cp.col.ID] = e.typ
		}
		ctes = append(ctes, lv.render(cells)...)
```

with:

```go
			c.levelTypes[cp.col.ID] = e.typ
		}
		pivotCells, err := c.pivotCells(lv, pivot)
		if err != nil {
			return nil, "", err
		}
		cells = append(cells, pivotCells...)
		ctes = append(ctes, lv.render(cells)...)
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
// run. Params are unset.
func compileDry(p *plan) error {
```

with:

```go
// run. Params are unset and the pivot has one value.
func compileDry(p *plan) error {
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
	_, _, err = c.groupStatement(s, r, &expansion{})
	return err
}
```

with:

```go
	var pivot []any
	if p.pivot != nil {
		pivot = []any{nil}
	}
	_, _, err = c.groupStatement(s, r, &expansion{}, pivot)
	return err
}
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
// columns describes the result's columns.
```

with:

```go
// columns describes the result's columns, pivot cell columns last.
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
		rn.currencyOfColumn(cp, &rc)
		out = append(out, rc)
	}
	return out
}
```

with:

```go
		rn.currencyOfColumn(cp, &rc)
		out = append(out, rc)
	}
	if pv := c.p.pivot; pv != nil {
		cell := pv.cell
		for j, key := range rn.pivotValues {
			rc := ResultColumn{
				ID: fmt.Sprintf("%s.p%d", cell.col.ID, j), Label: rn.pivotLabel(key),
				Type: c.levelTypes[cell.col.ID], Aggregate: cell.col.Aggregate, Format: cell.col.Format,
				Pivot: &PivotColumn{Cell: cell.col.ID, Key: key},
			}
			rn.currencyOfColumn(cell, &rc)
			if rc.CurrencyCell != "" {
				rc.CurrencyCell = cell.col.ID + "@currency"
			}
			out = append(out, rc)
		}
	}
	return out
}
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
// cells maps a statement row's v<idx> values to column ids, with each
// money column's currency.
```

with:

```go
// cells maps a statement row's v<idx> and pv<j> values to column ids, with
// each money column's currency.
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
			out[cp.col.ID+"@currency"] = row[ck]
		}
	}
	return out
}
```

with:

```go
			out[cp.col.ID+"@currency"] = row[ck]
		}
	}
	if pv := rn.c.p.pivot; pv != nil {
		for j := range rn.pivotValues {
			if v, ok := row[fmt.Sprintf("pv%d", j)]; ok {
				out[fmt.Sprintf("%s.p%d", pv.cell.col.ID, j)] = v
			}
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/pivot.go \
  core/server/reports/rows.go \
  core/server/reports/run.go \
  core/server/reports/assemble.go \
  core/server/reports/pivot_test.go
git commit -m "feat(core): report pivot with a first pass and a column cap"
```

---

### Task 13: Layout: sections and computed rows

**Files:**
- Create: `$WS/tinycld/core/server/reports/layout.go`
- Modify: `$WS/tinycld/core/server/reports/run.go`, `assemble.go`
- Test: `$WS/tinycld/core/server/reports/layout_test.go`

A section shows the first-level group whose key is its `key`, titled, always with its subtotal row; a first-level group no section names is left out. A computed row's formula reads `{subtotal: <section or earlier row>}`: for each number column and each pivot cell, `(SELECT o.v<idx> FROM o1 o WHERE o.k0 IS <key> AND o.ck<n> IS cur.ck<n>)`. An empty section counts as 0 (Decision 4). Computed rows come once per currency.

**Interfaces:**
- Consumes: `levelTypes`, `o1` from the group statement, `groupWithLabel`, `rowKey`, `currencyKey`, `currencySuffix`, `cells`.
- Produces: `(*compiler).layoutLegs(s, r, pivot []any) ([]string, error)`; `layoutCtx` (implements `fctx`: only `subtotal` and values); `layoutKey(raw) (any, error)`; `(*runner).layoutRows(t *tree, total map[string]any)`; `tree.computed`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/layout_test.go`:

```go
package reports

import (
	"testing"
)

// A statement in the zoo: sections pick first-level groups by key, computed
// rows read the sections' subtotals by name.
const zooStatement = `{"version":1,"source":"zoo.feedings","columns":[
	{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
	{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"},
	{"id":"grams","path":[{"field":"grams"}],"aggregate":"sum"}],
	"groups":[{"id":"g","col":"species"}],
	%s
	"layout":[
		{"section":"cats","title":"Lions","key":"lion"},
		{"section":"stripes","title":"Zebras","key":"zebra"},
		{"section":"apes","title":"Monkeys","key":"monkey"},
		{"row":"gap","label":"Lions less zebras","formula":{"op":"sub","args":[{"subtotal":"cats"},{"subtotal":"stripes"}]}},
		{"row":"all","label":"All animals","formula":{"op":"add","args":[{"subtotal":"gap"},{"op":"mul","args":[{"subtotal":"stripes"},{"value":2}]},{"subtotal":"apes"}]}}]}`

func TestLayoutSectionsAndComputedRows(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sprintf(zooStatement, ""), Options{}, nil)
	requireRows(t, res, "kind", "group", "subtotal", "group", "subtotal", "group", "subtotal", "computed", "computed")
	requireRows(t, res, "label", "Lions", "Total Lions", "Zebras", "Total Zebras", "Monkeys", "Total Monkeys", "Lions less zebras", "All animals")
	// Ann sees no monkey: its section is empty and counts as zero.
	requireRows(t, res, "cost", int64(3500), int64(3500), int64(1000), int64(1000), nil, nil, int64(2500), int64(4500))
	requireRows(t, res, "grams", int64(1300), int64(1300), int64(400), int64(400), nil, nil, int64(900), int64(1700))
	// A text column has no figure on a computed row, nor on an empty
	// section.
	requireRows(t, res, "species", "lion", "lion", "zebra", "zebra", nil, nil, nil, nil)
	if res.Rows[6].ID != `c:gap:["USD"]` {
		t.Fatalf("computed row id = %q", res.Rows[6].ID)
	}

	open := z.run(t, "ann", sprintf(zooStatement, ""), Options{ExpandAll: true}, nil)
	requireRows(t, open, "kind", "group", "detail", "detail", "subtotal", "group", "detail", "detail", "subtotal", "group", "subtotal", "computed", "computed")
}

func TestLayoutComputedRowsSplitThePivot(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sprintf(zooStatement, `"pivot":{"path":[{"field":"fed"}],"bucket":"month","cell":"cost"},`), Options{}, nil)
	requireRows(t, res, "label", "Lions", "Total Lions", "Zebras", "Total Zebras", "Monkeys", "Total Monkeys", "Lions less zebras", "All animals")
	requireRows(t, res, "cost.p0", int64(1000), int64(1000), int64(700), int64(700), nil, nil, int64(300), int64(1700))
	requireRows(t, res, "cost.p2", int64(0), int64(0), int64(300), int64(300), nil, nil, int64(-300), int64(300))
}

func TestLayoutErrors(t *testing.T) {
	z := newZoo(t)
	base := `{"version":1,"source":"zoo.feedings","columns":[
		{"id":"species","path":[{"link":"animal"},{"field":"species"}]},
		{"id":"cost","path":[{"field":"cost"}],"aggregate":"sum"}],
		"groups":[{"id":"g","col":"species"}],"layout":[{"section":"cats","title":"Lions","key":"lion"},%s]}`
	cases := map[string]struct {
		row, at, want string
		status        int
	}{
		"unknown section": {`{"row":"r","label":"R","formula":{"subtotal":"dogs"}}`, "layout.1.formula", "no section or earlier row", 422},
		"later row":       {`{"row":"r","label":"R","formula":{"subtotal":"s"}},{"row":"s","label":"S","formula":{"value":1}}`, "layout.1.formula", "no section or earlier row", 422},
		"a column":        {`{"row":"r","label":"R","formula":{"col":"cost"}}`, "layout.1.formula", "reads sections' subtotals", 400},
		"not a number":    {`{"row":"r","label":"R","formula":{"value":"x"}}`, "layout.1.formula", "is a number", 400},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := z.try(t, "ann", sprintf(base, c.row), Options{}, nil)
			requireSpecError(t, err, c.status, c.at, c.want)
			spec, _, _ := Load([]byte(sprintf(base, c.row)))
			requireSpecError(t, Validate(spec), c.status, c.at, c.want)
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL: `TestLayoutSectionsAndComputedRows`: `kind = [group group total]`, and the other layout tests.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/layout.go`:

```go
package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

// layoutLegs are the group statement's computed rows: one select per
// computed row (and currency), whose cells compute the row's formula from
// the first-level group rows its sections name. A formula reads sections
// and earlier computed rows by name, never by row position.
func (c *compiler) layoutLegs(s *stmt, r *rowsCTE, pivot []any) ([]string, error) {
	if len(c.p.layout) == 0 {
		return nil, nil
	}
	cur := "(SELECT 1) cur"
	if len(c.currencies) > 0 {
		cur = "(SELECT DISTINCT " + strings.Join(c.currencies, ", ") + " FROM o1) cur"
	}
	lc := &layoutCtx{c: c, s: s, items: map[string]*LayoutItem{}, visiting: map[string]bool{}}
	var legs []string
	for i, item := range c.p.layout {
		at := fmt.Sprintf("layout.%d", i)
		if item.Section != "" {
			lc.items[item.Section] = item
			continue
		}
		cells := []string{fmt.Sprintf("%d AS __level", len(c.p.groups)+1), s.bind(item.Row) + " AS __row"}
		for g := range c.p.groups {
			cells = append(cells, fmt.Sprintf("NULL AS k%d", g))
		}
		for _, ck := range c.currencies {
			cells = append(cells, "cur."+ck+" AS "+ck)
		}
		// Compiled once on no column, so a layout with no number columns
		// is still checked.
		lc.cell = "NULL"
		if _, err := lc.row(item, at+".formula"); err != nil {
			return nil, err
		}
		for idx, cp := range c.p.cols {
			if !isNumeric(c.levelTypes[cp.col.ID]) || c.levelTypes[cp.col.ID] == Bool {
				cells = append(cells, fmt.Sprintf("NULL AS v%d", idx))
				continue
			}
			lc.cell = fmt.Sprintf("v%d", idx)
			e, err := lc.row(item, at+".formula")
			if err != nil {
				return nil, err
			}
			cells = append(cells, e.sql+lc.cellSuffix())
		}
		for j := range pivot {
			lc.cell = fmt.Sprintf("pv%d", j)
			e, err := lc.row(item, at+".formula")
			if err != nil {
				return nil, err
			}
			cells = append(cells, e.sql+lc.cellSuffix())
		}
		cells = append(cells, fmt.Sprintf("%d AS __ord", i))
		legs = append(legs, "SELECT "+strings.Join(cells, ", ")+" FROM "+cur)
		lc.items[item.Row] = item
	}
	return legs, nil
}

// layoutCtx compiles a computed row's formula for one cell column: a
// {subtotal} leaf is that column's value on a section's group row, or on an
// earlier computed row.
type layoutCtx struct {
	c        *compiler
	s        *stmt
	items    map[string]*LayoutItem
	cell     string
	visiting map[string]bool
}

func (lc *layoutCtx) cellSuffix() string { return " AS " + lc.cell }

func (lc *layoutCtx) row(item *LayoutItem, at string) (expr, error) {
	e, err := compileFormula(lc, item.Formula, at)
	if err != nil {
		return expr{}, err
	}
	if !isNumeric(e.typ) || e.typ == Bool {
		return expr{}, invalid(at, "a computed row's formula is a number")
	}
	return e, nil
}

func (lc *layoutCtx) subtotal(id, at string) (expr, error) {
	item, ok := lc.items[id]
	if !ok {
		return expr{}, &SpecError{Status: 422, Problems: map[string]validation.Error{
			at: validation.NewError("unknown_subtotal", fmt.Sprintf("the layout has no section or earlier row %q", id)),
		}}
	}
	if item.Row != "" {
		done, err := enter(lc.visiting, id, at)
		if err != nil {
			return expr{}, err
		}
		defer done()
		return lc.row(item, at)
	}
	if lc.cell == "NULL" {
		return expr{sql: "NULL", typ: Number}, nil
	}
	key, err := layoutKey(item.Key)
	if err != nil {
		return expr{}, invalid(at, "a section key is text, a number, true, false or null")
	}
	conds := []string{"o.k0 IS " + lc.s.bind(key)}
	for _, ck := range lc.c.currencies {
		conds = append(conds, "o."+ck+" IS cur."+ck)
	}
	return expr{sql: fmt.Sprintf("(SELECT o.%s FROM o1 o WHERE %s)", lc.cell, strings.Join(conds, " AND ")), typ: Number}, nil
}

func layoutKey(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	switch x := v.(type) {
	case json.Number:
		return numberValue(x), nil
	case nil, string, bool:
		return x, nil
	}
	return nil, fmt.Errorf("not a scalar")
}

func (lc *layoutCtx) col(_, at string) (expr, error) { return expr{}, lc.only(at) }
func (lc *layoutCtx) path(_ Path, at string) (expr, error) {
	return expr{}, lc.only(at)
}
func (lc *layoutCtx) param(_, at string) (expr, error) { return expr{}, lc.only(at) }
func (lc *layoutCtx) aggregate(_ Aggregate, _ *Node, _ int, at string) (expr, error) {
	return expr{}, lc.only(at)
}
func (lc *layoutCtx) window(_ string, _ *Node, _ int, at string) (expr, error) {
	return expr{}, lc.only(at)
}
func (lc *layoutCtx) exists(_ *Node, at string) (expr, error) { return expr{}, lc.only(at) }
func (lc *layoutCtx) only(at string) error {
	return invalid(at, "a computed row reads sections' subtotals, earlier rows and values")
}
func (lc *layoutCtx) bind(v any) string   { return lc.s.bind(v) }
func (lc *layoutCtx) fiscalStart() string { return lc.bind(int64(lc.c.fiscal)) }
func (lc *layoutCtx) filter() bool        { return false }

// layoutRows emits a statement for one currency: each section's group row
// (titled, always with its subtotal) and each computed row, in the layout's
// order. First-level groups no section names are left out.
func (rn *runner) layoutRows(t *tree, total map[string]any) {
	ck := rn.currencyKey(total)
	byKey := map[string]map[string]any{}
	for _, g := range t.children[ck] {
		byKey[fmt.Sprint(g["k0"])] = g
	}
	for _, item := range rn.c.p.layout {
		if item.Row != "" {
			row := t.computed[item.Row+"|"+ck]
			if row == nil {
				row = map[string]any{}
			}
			id := "c:" + item.Row + rn.currencySuffix(total)
			rn.push(Row{ID: id, Kind: KindComputed, Label: item.Label, Cells: rn.cells(row)})
			continue
		}
		key, _ := layoutKey(item.Key)
		row := byKey[fmt.Sprint(key)]
		if row == nil {
			row = map[string]any{"k0": key}
			for _, name := range rn.c.currencies {
				row[name] = total[name]
			}
		}
		groupKey := rn.rowKey(row, 1)
		rn.groupWithLabel(t, row, 1, "", "g:"+keyString(groupKey), item.Title, groupKey, true)
	}
}
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
// groupPass runs the group statement: every group level and the total,
// capped at rowCap rows.
```

with:

```go
// groupPass runs the group statement: every group level, the total and the
// layout's computed rows, capped at rowCap rows.
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
// groupStatement is the UNION ALL of every level's rows (the children of
// expanded groups only).
```

with:

```go
// groupStatement is the UNION ALL of every level's rows (the children of
// expanded groups only) and the layout's computed rows.
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
		legs = append(legs, leg)
	}
	return ctes, strings.Join(legs, "\nUNION ALL\n") + "\nORDER BY __level, __ord", nil
```

with:

```go
		legs = append(legs, leg)
	}
	computed, err := c.layoutLegs(s, r, pivot)
	if err != nil {
		return nil, "", err
	}
	legs = append(legs, computed...)
	return ctes, strings.Join(legs, "\nUNION ALL\n") + "\nORDER BY __level, __ord", nil
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
	totals   []map[string]any
	details  map[string][]map[string]any
```

with:

```go
	totals   []map[string]any
	computed map[string]map[string]any // by row id and currency key
	details  map[string][]map[string]any
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
	t := &tree{children: map[string][]map[string]any{}, details: map[string][]map[string]any{}}
	for _, row := range groupRows {
		n := int(toInt(row["__level"]))
		switch {
		case n == 0:
```

with:

```go
	t := &tree{children: map[string][]map[string]any{}, computed: map[string]map[string]any{}, details: map[string][]map[string]any{}}
	for _, row := range groupRows {
		n := int(toInt(row["__level"]))
		switch {
		case row["__row"] != nil:
			t.computed[fmt.Sprint(row["__row"])+"|"+rn.currencyKey(row)] = row
		case n == 0:
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
	for _, total := range t.totals {
		for _, g := range t.children[rn.currencyKey(total)] {
```

with:

```go
	for _, total := range t.totals {
		if len(rn.c.p.layout) > 0 {
			rn.layoutRows(t, total)
			continue
		}
		for _, g := range t.children[rn.currencyKey(total)] {
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
// groupWithLabel emits a group row; subtotal says whether an expanded group
// ends in a subtotal row.
```

with:

```go
// groupWithLabel emits a group row; subtotal says whether an expanded group
// ends in a subtotal row (a layout section always does).
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
	if subtotal && expanded {
```

with:

```go
	if subtotal && (expanded || len(p.layout) > 0) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/layout.go \
  core/server/reports/run.go \
  core/server/reports/assemble.go \
  core/server/reports/layout_test.go
git commit -m "feat(core): report layout sections and computed rows"
```

---

### Task 14: Nested child rows

**Files:**
- Create: `$WS/tinycld/core/server/reports/nest.go`
- Modify: `$WS/tinycld/core/server/reports/run.go`, `assemble.go`
- Test: `$WS/tinycld/core/server/reports/nest_test.go`

Each nest level is one query: `SELECT <back> AS __parent, id AS __id, <cells> FROM r<n> … WHERE <back> IN (<parent ids>)`, the first level keyed by the ids in `w.n0` of the page's detail rows, each next level by the rows of the level above. Child rows follow their parent row with `parent` set and one more depth; their cells hold their own level's columns only.

**Interfaces:**
- Consumes: `plan.nest` (Task 8), `scope`, `runner.query`, `firstLabel`, `cellValue`.
- Produces: `(*rowsCTE).nestParent() string` (adds `n0` to `w`); `(*runner).nestPass(details) ([]map[any][]map[string]any, error)`; `(*runner).nestLevel(level int, parents []any)`; `distinct(rows, key) []any`; `(*runner).nestedRows(t, level, parentKey, parentID, section, depth)`; `tree.nested`; `assemble(groupRows, details, nested)`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/nest_test.go`:

```go
package reports

import (
	"testing"
)

const sitesWithAnimals = `{"version":1,"source":"zoo.sites","columns":[
	{"id":"site","path":[{"field":"name"}]},
	{"id":"animal","path":[{"link":"animals","mode":"nest"},{"field":"name"}]},
	{"id":"owner","path":[{"link":"animals","mode":"nest"},{"link":"owner"},{"field":"name"}]},
	{"id":"fed","path":[{"link":"animals","mode":"nest"},{"link":"feedings","mode":"nest"},{"field":"fed"}]}],
	"sort":[{"col":"site"}]}`

func TestNestedChildRowsHangUnderTheirParent(t *testing.T) {
	z := newZoo(t)
	res := z.run(t, "ann", sitesWithAnimals, Options{}, nil)
	requireRows(t, res, "label", "North", "Leo", "2026-01-05", "2026-02-10", "South", "Zed", "2026-01-20", "2026-03-03", "Total")
	requireRows(t, res, "owner", nil, "ann", nil, nil, nil, "bob", nil, nil, nil)
	north, leo := res.Rows[0], res.Rows[1]
	if leo.Parent != north.ID || leo.Depth != 1 || leo.ID != north.ID+"/"+z.id("leo") {
		t.Fatalf("leo = %+v", leo)
	}
	if fed := res.Rows[2]; fed.Parent != leo.ID || fed.Depth != 2 {
		t.Fatalf("feeding = %+v", fed)
	}
	// Parent rows have no value for a child row column.
	if _, ok := north.Cells["animal"]; !ok || north.Cells["animal"] != nil {
		t.Fatalf("north cells = %v", north.Cells)
	}
}

func TestNestedRowsTheReaderCannotSeeAreLeftOut(t *testing.T) {
	z := newZoo(t)
	// Bob may list mo and zed; in the north he sees mo, not leo.
	res := z.run(t, "bob", sitesWithAnimals, Options{}, nil)
	requireRows(t, res, "label", "North", "Mo", "2026-02-14", "South", "Zed", "2026-01-20", "2026-03-03", "Total")
}

func TestNestedRowsStopAtTheRowCap(t *testing.T) {
	z := newZoo(t)
	withLimits(t, func(l *limits) { l.rowCap = 1 })
	res := z.run(t, "ann", sitesWithAnimals, Options{}, nil)
	codes := map[string]bool{}
	for _, n := range res.Notices {
		codes[n.Code] = true
	}
	if !codes["nestCap"] {
		t.Fatalf("notices = %+v", res.Notices)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL: `TestNestedChildRowsHangUnderTheirParent`: `label = [North South Total]`, and the other nest tests.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/nest.go`:

```go
package reports

import (
	"fmt"
	"slices"
	"strings"
)

// nestParent puts in w, as n0, the id of the row the first nest level
// hangs from: the row the hops before the nest link reach.
func (r *rowsCTE) nestParent() string {
	hops := r.c.p.nest[0].hops
	return r.add("n0", q(r.root.join(hops[:len(hops)-1]), "id"))
}

// nestPass runs one query per nest level, each keyed by the ids of the
// level above: the base rows of the page, then each level's own rows.
// Linked rows the reader cannot see are left out.
func (rn *runner) nestPass(details []map[string]any) ([]map[any][]map[string]any, error) {
	p := rn.c.p
	if len(p.nest) == 0 {
		return nil, nil
	}
	var out []map[any][]map[string]any
	parents := distinct(details, "__n0")
	for level := range p.nest {
		rows, err := rn.nestLevel(level, parents)
		if err != nil {
			return nil, err
		}
		byParent := map[any][]map[string]any{}
		for _, row := range rows {
			byParent[row["__parent"]] = append(byParent[row["__parent"]], row)
		}
		out = append(out, byParent)
		parents = distinct(rows, "__next")
	}
	return out, nil
}

func distinct(rows []map[string]any, key string) []any {
	seen := map[any]bool{}
	var out []any
	for _, row := range rows {
		if v := row[key]; v != nil && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func (rn *runner) nestLevel(level int, parents []any) ([]map[string]any, error) {
	p := rn.c.p
	if len(parents) == 0 {
		return nil, nil
	}
	nl := p.nest[level]
	link := nl.hops[len(nl.hops)-1]
	s := newStmt(rn.app, rn.c.info)
	sc := newScope(s, link.to)
	back := q(sc.alias, link.link.BackField)
	sel := []string{back + " AS __parent", q(sc.alias, "id") + " AS __id"}
	var order []string
	for _, cp := range nl.cols {
		rest := &pathPlan{hops: cp.path.hops[len(nl.hops):], field: cp.path.field}
		v := sc.value(rest).sql
		sel = append(sel, fmt.Sprintf("%s AS v%d", v, p.index(cp)))
		order = append(order, "("+v+" IS NULL)", v)
	}
	if level+1 < len(p.nest) {
		next := p.nest[level+1].hops
		sel = append(sel, q(sc.join(next[len(nl.hops):len(next)-1]), "id")+" AS __next")
	}
	ids := make([]string, len(parents))
	for i, id := range parents {
		ids[i] = s.bind(id)
	}
	body := fmt.Sprintf("SELECT %s\n%s\nWHERE %s IN (%s)\nORDER BY __parent, %s LIMIT %s",
		strings.Join(sel, ", "), sc.render(), back, strings.Join(ids, ", "),
		strings.Join(append(order, "__id"), ", "), s.bind(int64(runLimits.rowCap+1)))
	rows, err := rn.query(s, nil, body)
	if err != nil {
		return nil, err
	}
	if len(rows) > runLimits.rowCap {
		rows = rows[:runLimits.rowCap]
		rn.notice(Notice{Code: "nestCap", Message: fmt.Sprintf("The report shows the first %d child rows.", runLimits.rowCap), Count: runLimits.rowCap})
	}
	return rows, nil
}

// nestedRows emits the child rows of one parent, each followed by its own
// children.
func (rn *runner) nestedRows(t *tree, level int, parentKey any, parentID, section string, depth int) {
	if level >= len(t.nested) || parentKey == nil {
		return
	}
	cols := rn.c.p.nest[level].cols
	for _, row := range t.nested[level][parentKey] {
		id := fmt.Sprintf("%s/%v", parentID, row["__id"])
		cells := map[string]any{}
		for _, cp := range cols {
			cells[cp.col.ID] = rn.cellValue(cp, row[fmt.Sprintf("v%d", rn.c.p.index(cp))])
		}
		rn.push(Row{ID: id, Kind: KindDetail, Depth: depth, Label: rn.firstLabel(slices.Clone(cols), row), Section: section, Parent: parentID, Cells: cells})
		rn.nestedRows(t, level+1, row["__next"], id, section, depth+1)
	}
}
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
	rn.res.Columns = rn.columns()
	rn.markCurrencies(groupRows)
	rn.assemble(groupRows, details)
```

with:

```go
	nested, err := rn.nestPass(details)
	if err != nil {
		return err
	}
	rn.res.Columns = rn.columns()
	rn.markCurrencies(groupRows)
	rn.assemble(groupRows, details, nested)
```

In `$WS/tinycld/core/server/reports/run.go`, replace:

```go
		c.detailTypes[cp.col.ID] = e.typ
	}
	return "SELECT " + strings.Join(sel, ", ") + " FROM w", order, nil
```

with:

```go
		c.detailTypes[cp.col.ID] = e.typ
	}
	if len(c.p.nest) > 0 {
		sel = append(sel, r.nestParent()+" AS __n0")
	}
	return "SELECT " + strings.Join(sel, ", ") + " FROM w", order, nil
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
	details  map[string][]map[string]any
}
```

with:

```go
	details  map[string][]map[string]any
	nested   []map[any][]map[string]any
}
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
func (rn *runner) assemble(groupRows, details []map[string]any) {
	t := &tree{children: map[string][]map[string]any{}, computed: map[string]map[string]any{}, details: map[string][]map[string]any{}}
```

with:

```go
func (rn *runner) assemble(groupRows, details []map[string]any, nested []map[any][]map[string]any) {
	t := &tree{children: map[string][]map[string]any{}, computed: map[string]map[string]any{}, details: map[string][]map[string]any{}, nested: nested}
```

In `$WS/tinycld/core/server/reports/assemble.go`, replace:

```go
// detail emits a detail row.
func (rn *runner) detail(t *tree, row map[string]any, section string, depth int) {
	id := fmt.Sprintf("d:%v", row["__id"])
	rn.push(Row{ID: id, Kind: KindDetail, Depth: depth, Label: rn.firstLabel(rn.c.p.cols, row), Section: section, Cells: rn.cells(row)})
}
```

with:

```go
// detail emits a detail row and the child rows nested under it.
func (rn *runner) detail(t *tree, row map[string]any, section string, depth int) {
	id := fmt.Sprintf("d:%v", row["__id"])
	rn.push(Row{ID: id, Kind: KindDetail, Depth: depth, Label: rn.firstLabel(rn.c.p.cols, row), Section: section, Cells: rn.cells(row)})
	if len(t.nested) > 0 {
		rn.nestedRows(t, 0, row["__n0"], id, section, depth+1)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/nest.go \
  core/server/reports/run.go \
  core/server/reports/assemble.go \
  core/server/reports/nest_test.go
git commit -m "feat(core): nested child rows in reports"
```

---

### Task 15: The run endpoint and `Register`

**Files:**
- Create: `$WS/tinycld/core/server/reports/endpoint.go`
- Test: `$WS/tinycld/core/server/reports/endpoint_test.go`

Error bodies are PocketBase `ApiError`s: `{"status", "message", "data"}`, where `data` maps each spec path to `{"code", "message"}` (codes `invalid`, `unknown_source`, `unknown_link`, `unknown_field`, `unknown_column`, `unknown_param`, `unknown_subtotal`). The tests drive the real router through `tests.ApiScenario`, which builds the router and runs `OnServe` for each scenario.

**Interfaces:**
- Consumes: `Load`, `Run`, `CheckSources`, `Refused`, the errors of Task 10.
- Produces: `func Register(app core.App)` — one `OnServe` handler: `CheckSources` (each refusal logged with `log.Error`), then `POST /api/reports/run` with `apis.RequireAuth("users")` and `apis.BodyLimit(1 MB)`; `handleRun`, `runBody{Spec, Params, Options}`, `ruleHeaders(h http.Header) map[string]string`, `runError(re, err) error`; `var log = logging.ForPackage("reports")`; `const maxRunBody = 1 << 20`.

- [ ] **Step 1: Write the failing tests**

`$WS/tinycld/core/server/reports/endpoint_test.go`:

```go
package reports

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/oauth"
)

func (z *zoo) post(t *testing.T, name, token, body string, status int, want ...string) {
	t.Helper()
	headers := map[string]string{}
	if token != "" {
		headers["Authorization"] = token
	}
	sc := tests.ApiScenario{
		Name: name, Method: http.MethodPost, URL: "/api/reports/run",
		Body: strings.NewReader(body), Headers: headers,
		ExpectedStatus: status, ExpectedContent: want,
		TestAppFactory:        func(testing.TB) *tests.TestApp { return z.app },
		DisableTestAppCleanup: true,
	}
	sc.Test(t)
}

func runBodyOf(spec string) string { return `{"spec":` + spec + `}` }

func TestRunEndpoint(t *testing.T) {
	z := newZoo(t)
	Register(z.app)
	ann := z.token(t, "ann")

	z.post(t, "a member runs a draft", ann, `{"spec":`+feedingsByDay+`,"params":{},"options":{"limit":10,"display":{"negative":"parens"}}}`,
		http.StatusOK, `"kind":"total"`, `"cost":4500`, `"topics":["collection/zoo_animals","collection/zoo_feedings","collection/zoo_keepers"]`)
	z.post(t, "signed out", "", runBodyOf(feedingsByDay), http.StatusUnauthorized, `"status":401`)
	z.post(t, "an invalid spec", ann, runBodyOf(`{"version":1,"source":"zoo.feedings","columns":[{"id":"1x","path":[{"field":"cost"}]}]}`),
		http.StatusBadRequest, `"message":"The report is not valid."`, `"columns.0.id":{"code":"invalid"`)
	z.post(t, "an unknown column", ann, runBodyOf(`{"version":1,"source":"zoo.feedings","columns":[{"id":"a","path":[{"field":"cost"}]}],"sort":[{"col":"b"}]}`),
		http.StatusUnprocessableEntity, `"sort.0.col":{"code":"unknown_column"`)
	z.post(t, "an unknown source", ann, runBodyOf(`{"version":1,"source":"zoo.gone","columns":[{"id":"a","path":[{"field":"cost"}]}]}`),
		http.StatusUnprocessableEntity, `"source":{"code":"unknown_source"`)
	z.post(t, "SQL is not a field", ann, `{"spec":`+feedingsByDay+`,"sql":"DELETE FROM zoo_feedings"}`,
		http.StatusBadRequest, `unknown field`)
	z.post(t, "no spec", ann, `{"params":{}}`, http.StatusBadRequest, `no spec`)
	z.post(t, "a body too large", ann, `{"spec":{"version":1,"columns":[],"x":"`+strings.Repeat("x", maxRunBody)+`"}}`,
		http.StatusRequestEntityTooLarge, `"status":413`)
	if n, _ := z.app.CountRecords("zoo_feedings"); n != 6 {
		t.Fatalf("the endpoint wrote: %d feedings", n)
	}
}

func TestRunEndpointRefusesASuperuser(t *testing.T) {
	z := newZoo(t)
	Register(z.app)
	superusers, err := z.app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	su := core.NewRecord(superusers)
	su.SetEmail("root@zoo.test")
	su.SetPassword("password123")
	if err := z.app.Save(su); err != nil {
		t.Fatal(err)
	}
	token, err := su.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	z.post(t, "a superuser", token, runBodyOf(feedingsByDay), http.StatusForbidden, `"status":403`)
}

func TestRunEndpointErrors(t *testing.T) {
	z := newZoo(t)
	Register(z.app)
	ann := z.token(t, "ann")
	withLimits(t, func(l *limits) { l.timeout = time.Nanosecond })
	z.post(t, "the time limit", ann, runBodyOf(feedingsByDay), http.StatusRequestTimeout, `took too long`)
	runLimits.timeout = 10 * time.Second
	if _, err := z.app.DB().NewQuery("UPDATE zoo_feedings SET cost = 9223372036854775807 WHERE note IN ('f1', 'f2')").Execute(); err != nil {
		t.Fatal(err)
	}
	z.post(t, "an amount too large", ann, runBodyOf(feedingsByDay), http.StatusUnprocessableEntity, `too large to total`)
}

func TestServeRefusesABrokenSourceBeforeAnyRun(t *testing.T) {
	z := newZoo(t)
	RegisterSource(Source{Key: "zoo.ghosts", Collection: "zoo_ghosts", Label: "Ghosts", Fields: []Field{{Key: "name", Label: "Name", Type: Text}}})
	Register(z.app)
	z.post(t, "a refused source", z.token(t, "ann"), runBodyOf(`{"version":1,"source":"zoo.ghosts","columns":[{"id":"a","path":[{"field":"name"}]}]}`),
		http.StatusUnprocessableEntity, `"source":{"code":"unknown_source"`)
	if _, bad := Refused()["zoo.ghosts"]; !bad {
		t.Fatal("serve did not refuse zoo.ghosts")
	}
}

// A report reads across every package's collections, and an OAuth token's
// scopes cover only some: the route stays session-only.
func TestRunEndpointIsNotOpenToOAuthTokens(t *testing.T) {
	if got := oauth.ScopeForRoute(http.MethodPost, "/api/reports/run"); len(got) != 0 {
		t.Fatalf("POST /api/reports/run resolved to scopes %v, want default-deny", got)
	}
}

func TestRuleHeadersReadLikePocketBase(t *testing.T) {
	got := ruleHeaders(http.Header{"X-Zoo-Gate": {"open", "shut"}, "Accept": {"application/json"}})
	want := map[string]string{"x_zoo_gate": "open", "accept": "application/json"}
	if len(got) != len(want) || got["x_zoo_gate"] != "open" || got["accept"] != "application/json" {
		t.Fatalf("ruleHeaders = %v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./reports/...`
Expected: FAIL to build: `undefined: Register`, `undefined: maxRunBody`, `undefined: ruleHeaders`.

- [ ] **Step 3: Write the implementation**

`$WS/tinycld/core/server/reports/endpoint.go`:

```go
package reports

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/inflector"

	"tinycld.org/core/logging"
)

var log = logging.ForPackage("reports")

// maxRunBody bounds a run request: a spec, its params and options.
const maxRunBody = 1 << 20

// Register binds the report engine. When the server starts (after
// migrations) it checks every registered source and logs each one it
// refuses, so a broken source never reaches a user. It serves
// POST /api/reports/run to signed-in users.
//
// The run endpoint is a read endpoint by POST because a draft spec does not
// fit in a URL. It reads only rows the caller's list rules allow and
// writes nothing. An OAuth bearer token cannot call it: oauth classifies no
// scope for it, so it is session-only by default-deny, because a report
// reads across every package's collections and a token's scopes cover
// only some.
func Register(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		if err := CheckSources(e.App); err != nil {
			refused := Refused()
			keys := make([]string, 0, len(refused))
			for key := range refused {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			for _, key := range keys {
				log.Error("report source refused", "source", key, "reason", refused[key])
			}
		}
		e.Router.POST("/api/reports/run", handleRun).
			Bind(apis.RequireAuth("users"), apis.BodyLimit(maxRunBody))
		return e.Next()
	})
}

// runBody is a draft report run: a spec, never SQL.
type runBody struct {
	Spec    json.RawMessage            `json:"spec"`
	Params  map[string]json.RawMessage `json:"params"`
	Options Options                    `json:"options"`
}

func handleRun(re *core.RequestEvent) error {
	var body runBody
	dec := json.NewDecoder(re.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return re.BadRequestError("The request is not a report run: "+err.Error(), nil)
	}
	if body.Spec == nil {
		return re.BadRequestError("The request has no spec.", nil)
	}
	spec, loaded, err := Load(body.Spec)
	if err != nil {
		return runError(re, err)
	}
	res, err := Run(re.Request.Context(), re.App, Request{
		Spec: spec, Loaded: loaded, Params: body.Params, Options: body.Options,
		Auth: re.Auth, Headers: ruleHeaders(re.Request.Header),
	})
	if err != nil {
		return runError(re, err)
	}
	return re.JSON(http.StatusOK, res)
}

// ruleHeaders are the headers as a rule's @request.headers reads them:
// the first value of each, its name in snake case ("X-Token" is x_token).
// They are built here, not by re.RequestInfo, which would read the body the
// handler has already decoded.
func ruleHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		if len(v) > 0 {
			out[inflector.Snakecase(k)] = v[0]
		}
	}
	return out
}

// runError answers a failed run: 400 with each invalid part of the spec,
// 422 naming each unknown source, link, field or column (and an amount too
// large to total), 408 at the time limit.
func runError(re *core.RequestEvent, err error) error {
	var specErr *SpecError
	switch {
	case errors.As(err, &specErr) && specErr.Status == http.StatusUnprocessableEntity:
		return re.Error(http.StatusUnprocessableEntity, "The report names something that does not exist.", specErr.Problems)
	case errors.As(err, &specErr):
		return re.Error(http.StatusBadRequest, "The report is not valid.", specErr.Problems)
	case errors.Is(err, ErrTimeout):
		return re.Error(http.StatusRequestTimeout, "The report took too long to run.", nil)
	case errors.Is(err, ErrAmountTooLarge):
		return re.Error(http.StatusUnprocessableEntity, "An amount is too large to total.", nil)
	case errors.Is(err, ErrNoReader):
		return re.ForbiddenError("A report runs as a signed-in user.", nil)
	}
	log.ErrorContext(re.Request.Context(), "report run failed", "err", err)
	return re.InternalServerError("The report could not run.", nil)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l reports && go vet -tags no_ui ./reports/... && go test -tags no_ui -count=1 ./reports/...`
Expected: `ok  tinycld.org/core/reports`; the log shows one `ERROR report source refused pkg=reports source=zoo.ghosts …` line from `TestServeRefusesABrokenSourceBeforeAnyRun`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/endpoint.go \
  core/server/reports/endpoint_test.go
git commit -m "feat(core): POST /api/reports/run and the report engine registration"
```

---

### Task 16: The rule-parity fuzz test

**Files:**
- Test: `$WS/tinycld/core/server/reports/fuzz_test.go`

For a random reader (ann, bob, carol), source and filter (`eq`, `ne`, `gt`, `lt`, `gte`, `lte` on number and text fields, `and`/`or` to depth 2), the engine's detail rows must be exactly the list API's rows for the same reader and filter, and a to-one linked value must equal the list API's `expand`. Each zoo collection's view rule equals its list rule, so `expand` (which reads the view rule) and the engine (which reads the list rule) see the same linked rows. `go test` runs the 40 seeds; `-fuzz` explores more.

**Interfaces:**
- Consumes: the zoo fixture (`newZoo`, `user`, `rec`, `mux`, `token`), `(z *zoo).run`, `Options`, `KindDetail`.
- Produces: `FuzzRuleParity(f *testing.F)`; helpers `growZoo`, `fuzzFilter`, `listExpanded`, `engineExpanded`, `keys`.

- [ ] **Step 1: Write the test**

`$WS/tinycld/core/server/reports/fuzz_test.go`:

```go
package reports

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"testing"
)

// The rule-parity fuzz test: for a random reader, source and filter, the
// engine's detail rows are exactly the rows PocketBase's list API returns
// for the same reader and filter, and a to-one linked value is the one the
// list API expands. Each seed builds one case; `go test -fuzz
// FuzzRuleParity` explores further seeds.

var fuzzWords = []string{"hay", "fish", "meat", "fruit", "seeds"}

// fuzzSource is a source the fuzzer filters: its collection, the fields a
// filter compares and a to-one link to expand.
type fuzzSource struct {
	key, collection string
	numbers, texts  []string
	link, linkField string
}

var fuzzSources = []fuzzSource{
	{"zoo.animals", "zoo_animals", []string{"weight", "price"}, []string{"name", "species"}, "site", "name"},
	{"zoo.feedings", "zoo_feedings", []string{"cost", "grams"}, []string{"note", "currency"}, "animal", "name"},
	{"zoo.keepers", "zoo_keepers", nil, nil, "animal", "species"},
	{"zoo.sites", "zoo_sites", nil, []string{"name"}, "", ""},
}

// growZoo adds random animals, keepers and feedings for three readers.
func growZoo(t testing.TB, z *zoo, rng *rand.Rand) {
	carol := z.user(t, "carol")
	readers := []string{z.id("ann"), z.id("bob"), carol.Id, ""}
	sites := []string{z.id("north"), z.id("south"), ""}
	var animals []string
	for i := range 20 {
		a := z.rec(t, fmt.Sprintf("a%d", i), "zoo_animals", map[string]any{
			"name": fuzzWords[rng.IntN(len(fuzzWords))], "species": fuzzWords[rng.IntN(len(fuzzWords))],
			"site": sites[rng.IntN(len(sites))], "owner": readers[rng.IntN(len(readers))],
			"weight": rng.IntN(400), "price": rng.IntN(100000),
		})
		animals = append(animals, a.Id)
	}
	for i := range 25 {
		user := readers[rng.IntN(3)]
		z.rec(t, fmt.Sprintf("kk%d", i), "zoo_keepers", map[string]any{"user": user, "animal": animals[rng.IntN(len(animals))]})
	}
	for i := range 60 {
		z.rec(t, fmt.Sprintf("ff%d", i), "zoo_feedings", map[string]any{
			"animal": animals[rng.IntN(len(animals))], "cost": rng.IntN(5000), "grams": rng.IntN(900),
			"currency": []string{"USD", "EUR"}[rng.IntN(2)], "note": fuzzWords[rng.IntN(len(fuzzWords))],
			"fed": fmt.Sprintf("2026-%02d-%02d 00:00:00.000Z", 1+rng.IntN(12), 1+rng.IntN(28)),
		})
	}
}

// fuzzFilter builds one random condition as a spec node and as the same
// PocketBase filter.
func fuzzFilter(rng *rand.Rand, src fuzzSource, depth int) (string, string) {
	leaves := len(src.numbers) + len(src.texts)
	if leaves == 0 {
		return "", ""
	}
	if depth > 0 && rng.IntN(3) == 0 {
		a, pa := fuzzFilter(rng, src, depth-1)
		b, pb := fuzzFilter(rng, src, depth-1)
		op, pop := "and", "&&"
		if rng.IntN(2) == 0 {
			op, pop = "or", "||"
		}
		return fmt.Sprintf(`{"op":%q,"args":[%s,%s]}`, op, a, b), "(" + pa + " " + pop + " " + pb + ")"
	}
	i := rng.IntN(leaves)
	if i < len(src.numbers) {
		field := src.numbers[i]
		ops := [][2]string{{"eq", "="}, {"ne", "!="}, {"gt", ">"}, {"lt", "<"}, {"gte", ">="}, {"lte", "<="}}
		o := ops[rng.IntN(len(ops))]
		v := rng.IntN(5000)
		return fmt.Sprintf(`{"op":%q,"args":[{"path":[{"field":%q}]},{"value":%d}]}`, o[0], field, v), fmt.Sprintf("%s %s %d", field, o[1], v)
	}
	field := src.texts[i-len(src.numbers)]
	words := append(append([]string{}, fuzzWords...), "USD", "EUR", "North")
	v := words[rng.IntN(len(words))]
	if rng.IntN(2) == 0 {
		return fmt.Sprintf(`{"op":"eq","args":[{"path":[{"field":%q}]},{"value":%q}]}`, field, v), fmt.Sprintf("%s = %q", field, v)
	}
	return fmt.Sprintf(`{"op":"ne","args":[{"path":[{"field":%q}]},{"value":%q}]}`, field, v), fmt.Sprintf("%s != %q", field, v)
}

// listExpanded reads id → the expanded link's field through the list API.
func (z *zoo) listExpanded(t *testing.T, mux http.Handler, src fuzzSource, user, filter string) map[string]any {
	t.Helper()
	q := url.Values{"perPage": {"500"}, "skipTotal": {"1"}}
	if filter != "" {
		q.Set("filter", filter)
	}
	if src.link != "" {
		q.Set("expand", src.link)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/collections/"+src.collection+"/records?"+q.Encode(), nil)
	req.Header.Set("Authorization", z.token(t, user))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list %s %q: %d %s", src.collection, filter, rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := map[string]any{}
	for _, item := range body.Items {
		var linked any
		if expand, ok := item["expand"].(map[string]any); ok {
			if rec, ok := expand[src.link].(map[string]any); ok {
				linked = rec[src.linkField]
			}
		}
		out[item["id"].(string)] = linked
	}
	return out
}

func (z *zoo) engineExpanded(t *testing.T, src fuzzSource, user, filter string) map[string]any {
	t.Helper()
	cols := `{"id":"id","path":[{"field":"id"}]}`
	if src.link != "" {
		cols += fmt.Sprintf(`,{"id":"linked","path":[{"link":%q},{"field":%q}]}`, src.link, src.linkField)
	}
	spec := fmt.Sprintf(`{"version":1,"source":%q,"columns":[%s]`, src.key, cols)
	if filter != "" {
		spec += `,"filter":` + filter
	}
	res := z.run(t, user, spec+"}", Options{Limit: 1000}, nil)
	out := map[string]any{}
	for _, row := range res.Rows {
		if row.Kind == KindDetail {
			out[row.Cells["id"].(string)] = row.Cells["linked"]
		}
	}
	return out
}

func FuzzRuleParity(f *testing.F) {
	for seed := range uint64(40) {
		f.Add(seed)
	}
	// One grown zoo serves every seed this process runs; a seed only reads.
	z := newZoo(f)
	growZoo(f, z, rand.New(rand.NewPCG(1, 2)))
	mux := z.mux(f)
	f.Fuzz(func(t *testing.T, seed uint64) {
		rng := rand.New(rand.NewPCG(seed, 7))
		src := fuzzSources[rng.IntN(len(fuzzSources))]
		user := []string{"ann", "bob", "carol"}[rng.IntN(3)]
		filter, pbFilter := fuzzFilter(rng, src, 2)
		got := z.engineExpanded(t, src, user, filter)
		want := z.listExpanded(t, mux, src, user, pbFilter)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("seed %d: %s as %s, filter %s\nengine: %v\nlist:   %v", seed, src.key, user, pbFilter, keys(got), keys(want))
		}
	})
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, fmt.Sprintf("%s=%v", k, v))
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 2: Run it**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -run FuzzRuleParity -v ./reports/... 2>&1 | grep -c -- "--- PASS: FuzzRuleParity/"`
Expected: `40`. It passes at once: it guards behaviour Tasks 4 and 9 built.

- [ ] **Step 3: Prove it catches a broken rule, then undo**

In `rules.go`, change `case *col.ListRule != "":` to `case false && *col.ListRule != "":` (every rule becomes public).

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -run FuzzRuleParity ./reports/...`
Expected: FAIL with a `seed N: … engine: [...] list: [...]` message (the engine now shows rows the list API hides).

Undo the change (`git diff core/server/reports/rules.go` shows nothing), then:

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -run "^$" -fuzz FuzzRuleParity -fuzztime 20s ./reports/`
Expected: `PASS` after about 20 s of fuzzing.

- [ ] **Step 4: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/reports/fuzz_test.go
git commit -m "test(core): fuzz report rows against the list API rule by rule"
```

---

### Task 17: Register the report engine in the shared composition

**Files:**
- Modify: `$WS/tinycld/core/server/coreserver/server.go` (`RegisterSharedCore`, after `changesignal.Register(app)`; import `"tinycld.org/core/reports"`)
- Modify: `$WS/tinycld/core/server/coreserver/composition_parity_test.go` (`hostHookCounts`)

**Interfaces:**
- Consumes: `reports.Register(app core.App)` (Task 15).
- Produces: every composition serves `POST /api/reports/run` and checks report sources at start.

- [ ] **Step 1: Update the golden count first (the failing test)**

In `composition_parity_test.go` change `"OnServe": 36,` to:

```go
	"OnServe":                             37,
```

- [ ] **Step 2: Run the tripwire to verify it fails**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./coreserver/ -run TestRegisterBindsTheRecordedHandlerCounts`
Expected: FAIL: `OnServe: Register binds 36 handler(s), recorded 37`.

- [ ] **Step 3: Register it**

In `server.go`, add the import `"tinycld.org/core/reports"` after `"tinycld.org/core/realtime"`, and directly after `changesignal.Register(app)`:

```go
	// The report engine: checks every registered report source at start and
	// serves POST /api/reports/run. Shared: a report reads with its reader's
	// own rules wherever it runs. Inert with no registered source.
	reports.Register(app)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l coreserver && go vet -tags no_ui ./coreserver/ && go test -tags no_ui -count=1 ./coreserver/ -run TestRegisterBindsTheRecordedHandlerCounts`
Expected: no gofmt or vet output; `ok  tinycld.org/core/coreserver`.

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH tsx scripts/check-core-isolation.ts`
Expected: exit 0, `0 reference(s)` (the engine names only fictional `zoo` sources, in tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/coreserver/server.go \
  core/server/coreserver/composition_parity_test.go
git commit -m "feat(core): register the report engine in the shared composition"
```

---

### Task 18: `docs/packages.md`: report sources, and the final check

**Files:**
- Modify: `$WS/tinycld/docs/packages.md` — the registry table in "### Registries: how core learns what a package provides", and a new subsection "### Report sources" directly before "### Test build tag".

**Interfaces:**
- Consumes: the Go API of Tasks 3, 4 and 15.
- Produces: package-author documentation. No in-app help topic (Decision 18).

- [ ] **Step 1: Add the registry row**

After the table row for `changesignal.RegisterView` add:

```markdown
| which of its collections reports may read, with their fields and links (see "Report sources" below) | `reports.RegisterSource` |
```

- [ ] **Step 2: Add the subsection**

Insert before `### Test build tag`:

````markdown
### Report sources

Core's report engine (`tinycld.org/core/reports`) runs reports over every
package's data. A report starts from a source and follows the source's
links. It reads only collections, fields and links that a source registers.
Register sources from the package's `Register(app)`:

```go
reports.RegisterSource(reports.Source{
    Key:        "zoo.feedings", // "<slug>.<name>", stable
    Collection: "zoo_feedings",
    Label:      "Feedings",
    Fields: []reports.Field{
        {Key: "cost", Label: "Cost", Type: reports.Money, Aggregates: reports.SumAll, Currency: "currency"},
        {Key: "currency", Label: "Currency", Type: reports.Text},
        {Key: "fed", Label: "Fed", Type: reports.Date, Aggregates: reports.MinMax},
    },
    Links: []reports.Link{
        {Key: "animal", Label: "Animal", Target: "zoo.animals", Cardinality: reports.ToOne, Field: "animal"},
    },
    FiscalStartMonth: func(app core.App) int { return 1 },
})
```

- Every link declares its cardinality. A to-one link names its single
  relation `Field` on this source. A to-many link names its `BackField`: the
  single relation on the target that points back at this source.
- Field types are `Text`, `Number`, `Money` (integer cents), `Date`,
  `DateTime`, `Bool`, `Select` (with `Options` for the labels) and
  `Relation`. A money field names a `Currency` text field of the same source,
  or the source gives a fixed currency with `Currency`. A field offers the
  aggregates in `Aggregates` (`SumAll`, `MinMax`, `CountOnly`); with none it
  can be counted. Every source also offers `id`.
- To rename or remove a field or a link, keep the old key in `Aliases`
  (`"old": "new"`). Saved reports then keep working.
- `FiscalStartMonth` (1 to 12) sets the fiscal year for the source's reports:
  the fiscal presets, `fiscalYear` and `fiscalPeriod`.

When the server starts, core checks every source against the database: the
collection and each column exist with matching types, no column is hidden
from the API, each link follows its relation, and the collection's list rule
can be built for a reader. A source that fails, or links to a source that
fails, is refused: core logs it and reports cannot use it. Pin your sources
in the package's tests, after its migrations apply:

```go
if err := reports.CheckSources(app); err != nil {
    t.Fatal(err)
}
```

A report runs as its reader. Every collection it reads, in every join and
subquery, is filtered by the reader's own list rule: a linked row the reader
cannot see leaves empty cells, and totals across a to-many link leave it
out. A report result lists the change-signal topics of every collection it
read, so a raw-SQL write to a source's collection must call
`changesignal.Touch` (see "Change signals and live views" above).
````

- [ ] **Step 3: Check the result**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && grep -n "reports\.RegisterSource\|reports\.CheckSources" docs/packages.md`
Expected: the table row, the example and the `CheckSources` snippet. Read the section once to confirm the nested code fences close.

- [ ] **Step 4: Run every check once**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -race ./reports/... ./changesignal/... ./forms/... && go test -tags no_ui -count=1 ./coreserver/...`
Expected: `ok` for each package (the `reports` race run takes about two minutes).

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH tinycld-pkg check && PATH=/Users/nas/tmp/tinycld/books-purchases/node_modules/.bin:$PATH tsx scripts/check-core-isolation.ts`
Expected: Biome, tsc and vitest pass for the `tinycld` member; isolation exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add docs/packages.md
git commit -m "docs(core): report sources for package authors"
```

---

## Spec coverage

| Spec item (§2, and the Errors, Security and Testing parts that apply) | Where |
|---|---|
| Packages register sources from `Register(app)`: key, collection, label, primary key, fields, links, aliases | Task 3 |
| Every link declares cardinality and target; a to-many link names its back-relation field; a link without them is refused at registration | Task 3 (panic), Task 4 (schema check) |
| Field types (text, number, money with a currency field or fixed currency, date, datetime, bool, select with labels, relation id) set formats and aggregates | Tasks 3, 4, 10 (column types, `currency`, `options`) |
| A field is removed or renamed only with an alias | Task 3 (alias rules), Task 5 (`Load` resolves them), Task 10 (`aliased` notice) |
| A source whose list rule the compiler cannot inline is refused at registration with the reason | Tasks 4, 15 (checked at server start, logged, left out) |
| The report spec: versioned JSON, validated on save and on run | Tasks 5, 8, 10; on save → p5-report-sharing (calls `Load` + `Validate`) |
| A path stores the link at each hop; shared prefixes share one join; maximum depth 4 hops | Tasks 8, 9 |
| To-many hop `mode`: aggregate (per-parent subquery) or nest (child rows) | Tasks 8, 9, 10, 14 |
| `with: required | optional` | Tasks 8, 9 |
| `exists` / `notExists` with a link path and a sub-filter, combinable with and/or/not | Task 9 |
| Typed params (`date`, `asOf`, `dateRange` with presets, `choice`, `text`, `number`); chips edit params | Tasks 7, 9, 10 |
| `layout`: ordered sections by group key with title and subtotal; computed rows by name | Task 13 |
| Spec versions: integer version, an upgrade function per version, upgraded on read | Task 5 |
| Field keys resolved through aliases on run and on save | Task 5 (`Load`), Task 10 (run); save → p5-report-sharing |
| `reports validate` (also at dev startup) lists saved reports with unknown references and their owner; the admin list shows them broken | p5-report-sharing (uses `Load` + `Validate`, whose 422 names each missing part); the broken badge → p5-report-builder |
| A report with an unresolved reference opens in an error state naming the missing part | Tasks 8, 15 (422 with each missing part); the error state → p5-report-builder |
| Compiler 1. Rule CTEs for every touched collection, read everywhere | Tasks 4, 9 (`stmt.rule` in every scope) |
| Compiler 2. Base filtered by the spec filter and params | Task 9 (`w`) |
| Compiler 3. To-one joins per distinct path prefix (inner with `required`) | Task 9 |
| Compiler 4. To-many aggregate subquery per distinct to-many path; fan-out is a compile error | Tasks 8, 9, 10 |
| Compiler 5. Nested rows: a query per nest level keyed by parent ids | Task 14 |
| Compiler 6. Computed columns compiled to SQL; filterable, sortable, groupable | Tasks 6, 9, 10 |
| Compiler 7. GROUP BY per level, subtotals by UNION ALL, lazy group expansion | Task 10 |
| Compiler 8. Pivot first pass with `maxColumns + 1`, cells by `CASE`, cap notice with the count left out | Task 12 |
| Compiler 9. Layout final CTE with section rows and computed rows | Task 13 |
| Compiler 10. Detail rows page by keyset; group and pivot results capped at 5,000 with a notice | Tasks 10, 11, 12 |
| Compiler 11. Time limit per statement (10 s), timeout error | Tasks 10, 15 |
| Rules: resolver per reader; `@collection` and back-relation rules; never guessed or skipped | Tasks 4, 9, 16 |
| Empty rule public, null rule superuser-only; never a superuser token | Tasks 4, 10 (`ErrNoReader`), 15 (`RequireAuth("users")`) |
| To-one linked row hidden → empty cells, parent kept; to-many hidden rows left out | Tasks 9, 14 |
| Fuzz test against the PocketBase list API | Task 16 |
| Formulas: one tree, leaves, every listed operator | Task 6 (operators), Task 10 (aggregates and windows in context), Task 13 (`subtotal`) |
| Go functions registered in SQLite for gaps (fiscal periods, integer-exact rounding) | Task 1 |
| Shared formula test table for the forms evaluator (TS and Go) and the compiler | Task 6 |
| The builder uses the forms engine's structured formula editor | p5-report-builder |
| Money: integer cents, exact `sum()`, overflow → "amount too large", no `total()` or float `avg()` | Tasks 1, 6, 10 |
| Division with explicit scale, half away from zero, integer arithmetic | Tasks 1, 6 |
| Display rounding stays in the client formatter | Decision 17 (`options.display` not read); formatter → p5-report-builder |
| Mixed currencies grouped by currency, columns marked | Task 10 |
| `POST /api/reports/run`, auth required, `{ spec, params, options }` | Task 15 |
| `{ reportId, params, options }` and the 403 for a saved report the caller cannot view | p5-report-sharing |
| `options`: display options, group expansion keys, page cursor | Tasks 10, 11 |
| Response `{ columns, rows, notices, topics, page }` in the shell's row shape | Task 10 (Decision 11), Task 2 (topics) |
| Errors: 400 field-level list, 422 unknown reference, 408 timeout; read-only | Task 15 |
| Errors section: run failure or timeout → the shell's error state with Retry; caps → a notice; no access | Tasks 10–15 (errors and notices); UI → p5-report-builder; no access → p5-report-sharing |
| Security: never SQL, columns only from the registry, values always bound | Tasks 5 (strict decode), 6 (`TestLiteralsBindAndNeverInline`), 9, 15 (`SQL is not a field`) |
| Security: every touched collection's list rule in every subquery | Tasks 4, 9, 16 |
| Testing: spec validation, upgrades, aliases | Tasks 5, 8 |
| Testing: compiler output per part (rule CTEs, joins, per-parent aggregates, fan-out error, nests, exists, groups and subtotals, pivot pass and cap, layout and computed rows, paging, time limit) | Tasks 4, 8, 9, 10, 11, 12, 13, 14 |
| Testing: money (overflow, division scale and rounding, mixed currencies) | Tasks 1, 6, 10 |
| Testing: rules with `@collection` and back-relation rules, hidden linked rows | Tasks 4, 9 |
| Change signal topics of every collection the query reads | Tasks 2, 10 |
| Source catalog for the builder ("Columns: a tree of the source's fields and links") | p5-report-builder (reads `reports.Sources()`) |
| Saved reports, sharing, publishing, offboarding | p5-report-sharing |
| Hub, report view, builder, share dialog, help topic | p5-report-builder |
| Books sources (accounts, journal entries and lines, balances, customers, settings) | p5-trial-balance |
| Composition and isolation | Task 17 |
| Package-author documentation | Task 18 |

## Concerns for the reviewer

- **Read-only pause:** `core/server/readonly` refuses every POST with 503 during a migration pause, so a report run in that window fails and the client must retry (the shell's Retry). Exempting this one read-only POST would need an allow list in `readonly`; this plan does not add one.
- **Row kinds:** the shell's `ReportModelRow` has the kind `section` where the spec (and this engine) says `group`, and has no `computed`. `p5-report-builder` moves the shell into core and adapts it; until then no client reads this endpoint.
- **`p5-report-sharing` reuse:** it runs a saved report with `reports.Run(ctx, app, reports.Request{Spec, Loaded, Params, Options, Auth, Headers})` after `reports.Load(record.spec)`, validates on save with `reports.Validate`, and lists broken reports from `Validate`'s 422 problems.
