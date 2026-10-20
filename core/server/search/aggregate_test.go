package search

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/background"
)

// testApp gives Aggregate a real core.App, which it needs only for its logger.
func testApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })
	return app
}

// rowSource returns a source that answers with the given rows.
func rowSource(slug string, order int, total int, titles ...string) Source {
	rows := make([]Row, len(titles))
	for i, title := range titles {
		rows[i] = Row{ID: slug + "-" + title, Title: title}
	}
	if total == 0 {
		total = len(rows)
	}
	return Source{
		Slug: slug, Label: slug, Order: order,
		Search: func(core.App, string, Query) (Result, error) {
			return Result{Rows: rows, Total: total}, nil
		},
	}
}

func titlesOf(rows []Row) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Title
	}
	return out
}

func TestAggregateMergesAndOrdersAcrossPackages(t *testing.T) {
	// The case that motivates scoring at all: without it, nav.order alone would
	// put gizmos's weak hit above cogs's exact title match.
	app := testApp(t)
	sources := []Source{
		{
			Slug: "gizmos", Order: 5,
			Search: func(core.App, string, Query) (Result, error) {
				return Result{Rows: []Row{{ID: "m1", Title: "Q3 approval", Subtitle: "budget team"}}, Total: 1}, nil
			},
		},
		rowSource("cogs", 12, 1, "budget"),
	}

	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, sources)
	if got := titlesOf(resp.Rows); len(got) != 2 || got[0] != "budget" {
		t.Fatalf("rows = %v, want cogs's exact match first", got)
	}
	if resp.Counts["gizmos"] != 1 || resp.Counts["cogs"] != 1 {
		t.Fatalf("counts = %v", resp.Counts)
	}
}

func TestAggregateStampsSlugFromTheSource(t *testing.T) {
	// A source must not be able to label rows as another package's.
	app := testApp(t)
	liar := Source{
		Slug: "gadgets", Order: 25,
		Search: func(core.App, string, Query) (Result, error) {
			return Result{Rows: []Row{{Slug: "gizmos", ID: "c1", Title: "x"}}, Total: 1}, nil
		},
	}
	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"x"}}, []Source{liar})
	if len(resp.Rows) != 1 || resp.Rows[0].Slug != "gadgets" {
		t.Fatalf("rows = %+v, want slug stamped as cards", resp.Rows)
	}
}

func TestAggregateIsolatesAFailingSource(t *testing.T) {
	// Contractual, inherited from the client fan-out this replaces: "one
	// backend erroring must not empty the whole palette."
	app := testApp(t)
	sources := []Source{
		{
			Slug: "gizmos", Order: 5,
			Search: func(core.App, string, Query) (Result, error) {
				return Result{}, errors.New("index corrupt")
			},
		},
		rowSource("cogs", 12, 1, "budget"),
	}

	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, sources)
	if len(resp.Rows) != 1 || resp.Rows[0].Slug != "cogs" {
		t.Fatalf("rows = %+v, want cogs's row despite gizmos failing", resp.Rows)
	}
	if len(resp.Partial) != 1 || resp.Partial[0] != "gizmos" {
		t.Fatalf("partial = %v, want [gizmos] — a dropped package must be reported", resp.Partial)
	}
	if _, counted := resp.Counts["gizmos"]; counted {
		t.Error("a failed source must not report a count, which would read as a real zero")
	}
}

func TestAggregateIsolatesAPanickingSource(t *testing.T) {
	app := testApp(t)
	sources := []Source{
		{
			Slug: "gadgets", Order: 25,
			Search: func(core.App, string, Query) (Result, error) {
				panic("nil map write")
			},
		},
		rowSource("cogs", 12, 1, "budget"),
	}

	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, sources)
	if len(resp.Rows) != 1 {
		t.Fatalf("a panicking package must degrade to no rows, got %+v", resp.Rows)
	}
	if len(resp.Partial) != 1 || resp.Partial[0] != "gadgets" {
		t.Fatalf("partial = %v, want [cards]", resp.Partial)
	}
}

// shortenSourceTimeout sets sourceTimeout for one test. Call it before
// testApp, so the restore runs after the app's Cleanup has waited for every
// source job: a job still reading the var would race the restore.
func shortenSourceTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	prev := sourceTimeout
	sourceTimeout = d
	t.Cleanup(func() { sourceTimeout = prev })
}

func TestAggregateTimesOutASlowSourceWithoutBlockingTheRest(t *testing.T) {
	const timeout = 100 * time.Millisecond
	shortenSourceTimeout(t, timeout)
	app := testApp(t)
	slow := Source{
		Slug: "gizmos", Order: 5,
		// Ignores its context, as a source that has not adopted it does.
		Search: func(core.App, string, Query) (Result, error) {
			time.Sleep(2 * timeout)
			return Result{}, nil
		},
	}
	sources := []Source{slow, rowSource("cogs", 12, 1, "budget")}

	start := time.Now()
	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, sources)
	elapsed := time.Since(start)

	if elapsed >= 2*timeout {
		t.Fatalf("waited %v — a slow source must be cut off, not awaited", elapsed)
	}
	if len(resp.Rows) != 1 || resp.Rows[0].Slug != "cogs" {
		t.Fatalf("rows = %+v, want cogs's row", resp.Rows)
	}
	if len(resp.Partial) != 1 || resp.Partial[0] != "gizmos" {
		t.Fatalf("partial = %v, want [gizmos]", resp.Partial)
	}
}

func TestAggregateRequiresAPositiveTerm(t *testing.T) {
	// FTS5 errors on a NOT-only MATCH — there is nothing to subtract from — so
	// an exclude-only query must yield empty rather than reach any source.
	app := testApp(t)
	called := false
	src := Source{
		Slug: "gizmos", Order: 5,
		Search: func(core.App, string, Query) (Result, error) {
			called = true
			return Result{}, nil
		},
	}

	resp := Aggregate(context.Background(), app, "u1", Query{Exclude: []string{"draft"}}, []Source{src})
	if called {
		t.Error("an exclude-only query must not reach a source")
	}
	if len(resp.Rows) != 0 {
		t.Errorf("rows = %+v, want none", resp.Rows)
	}
}

func TestAggregateRefusesAnUnauthenticatedCaller(t *testing.T) {
	app := testApp(t)
	called := false
	src := Source{
		Slug: "gizmos", Order: 5,
		Search: func(core.App, string, Query) (Result, error) {
			called = true
			return Result{}, nil
		},
	}
	Aggregate(context.Background(), app, "", Query{Include: []string{"budget"}}, []Source{src})
	if called {
		t.Error("no userID must mean no source call — scoping depends on it")
	}
}

func TestAggregateReportsTruncation(t *testing.T) {
	// A client that cannot tell "5 results" from "5 of 500" will imply
	// completeness it was never given.
	app := testApp(t)
	src := rowSource("gizmos", 5, 500, "budget a", "budget b")

	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, []Source{src})
	if len(resp.Truncated) != 1 || resp.Truncated[0] != "gizmos" {
		t.Fatalf("truncated = %v, want [gizmos]", resp.Truncated)
	}
	if resp.Counts["gizmos"] != 500 {
		t.Fatalf("count = %d, want the source's full total", resp.Counts["gizmos"])
	}
}

func TestAggregatePagesTheMergedSet(t *testing.T) {
	// Paging must happen after the merge: forwarding Offset to each source
	// would page every package independently and silently drop rows.
	app := testApp(t)
	var gotOffset int
	src := Source{
		Slug: "gizmos", Order: 5,
		Search: func(_ core.App, _ string, q Query) (Result, error) {
			gotOffset = q.Offset
			return Result{Rows: []Row{
				{ID: "1", Title: "budget one"},
				{ID: "2", Title: "budget two"},
				{ID: "3", Title: "budget three"},
			}, Total: 3}, nil
		},
	}

	resp := Aggregate(context.Background(), app, "u1",
		Query{Include: []string{"budget"}, Limit: 1, Offset: 1}, []Source{src})
	if gotOffset != 0 {
		t.Errorf("source saw offset %d — it must always report from its first hit", gotOffset)
	}
	if len(resp.Rows) != 1 {
		t.Fatalf("rows = %+v, want one", resp.Rows)
	}

	// An offset past the end is an empty page, not an error.
	resp = Aggregate(context.Background(), app, "u1",
		Query{Include: []string{"budget"}, Limit: 5, Offset: 99}, []Source{src})
	if len(resp.Rows) != 0 {
		t.Fatalf("rows = %+v, want none past the end", resp.Rows)
	}
}

func TestAggregateOverFetchesSoRankingCanChoose(t *testing.T) {
	// Each source must be asked for more than the page size, or a package whose
	// hits all score poorly still occupies its share of the merged page.
	app := testApp(t)
	var gotLimit int
	src := Source{
		Slug: "gizmos", Order: 5,
		Search: func(_ core.App, _ string, q Query) (Result, error) {
			gotLimit = q.Limit
			return Result{}, nil
		},
	}
	Aggregate(context.Background(), app, "u1", Query{Include: []string{"x"}, Limit: 10}, []Source{src})
	if gotLimit <= 10 {
		t.Fatalf("source limit = %d, want more than the page size", gotLimit)
	}
}

// A source still running at sourceTimeout is told to stop: its context ends,
// so its query is cancelled and its goroutine returns rather than running on.
func TestAggregateCancelsASlowSourceAtTheTimeout(t *testing.T) {
	shortenSourceTimeout(t, 50*time.Millisecond)
	app := testApp(t)
	ended := make(chan error, 1)
	slow := Source{
		Slug: "gizmos", Order: 5,
		Search: func(_ core.App, _ string, q Query) (Result, error) {
			<-q.Context().Done()
			ended <- q.Context().Err()
			return Result{}, q.Context().Err()
		},
	}

	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, []Source{slow})
	if len(resp.Partial) != 1 || resp.Partial[0] != "gizmos" {
		t.Fatalf("partial = %v, want [gizmos]", resp.Partial)
	}
	select {
	case err := <-ended:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the source's context ended with %v, want the timeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the slow source was never cancelled: its goroutine runs on after the request")
	}
}

// The request ending (the client went away) cancels a source still running.
func TestAggregateCancelsASourceWhenTheRequestEnds(t *testing.T) {
	app := testApp(t)
	reqCtx, cancelReq := context.WithCancel(context.Background())
	started := make(chan struct{})
	ended := make(chan struct{})
	slow := Source{
		Slug: "gizmos", Order: 5,
		Search: func(_ core.App, _ string, q Query) (Result, error) {
			close(started)
			<-q.Context().Done()
			close(ended)
			return Result{}, q.Context().Err()
		},
	}
	go func() {
		<-started
		cancelReq()
	}()

	resp := Aggregate(reqCtx, app, "u1", Query{Include: []string{"budget"}}, []Source{slow})
	if len(resp.Partial) != 1 {
		t.Fatalf("partial = %v, want [gizmos]", resp.Partial)
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the source was not cancelled when the request ended")
	}
}

// A source the request gave up on can still be querying when the app
// terminates. The terminate waits for it, with its context ended, so its query
// never runs against a closed database.
func TestTerminateWaitsForASourceStillRunning(t *testing.T) {
	shortenSourceTimeout(t, 50*time.Millisecond)
	app := testApp(t)
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var dbOpenAtEnd atomic.Bool
	slow := Source{
		Slug: "gizmos", Order: 5,
		// Ignores the context past the cancel for a while, as a source with a
		// query in flight does, then touches the database.
		Search: func(a core.App, _ string, q Query) (Result, error) {
			<-q.Context().Done()
			close(cancelled)
			<-release
			dbOpenAtEnd.Store(a.ConcurrentDB() != nil)
			return Result{}, nil
		},
	}

	// Runs before the app's Cleanup (cleanups run last-in first-out), which
	// would otherwise wait forever on the held source after a failure.
	var once sync.Once
	letGo := func() { once.Do(func() { close(release) }) }
	t.Cleanup(letGo)

	Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, []Source{slow})
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the source was never cancelled at the timeout")
	}

	terminated := make(chan struct{})
	go func() {
		app.(*tests.TestApp).Cleanup()
		close(terminated)
	}()
	select {
	case <-terminated:
		t.Fatal("terminate returned while a source was still running")
	case <-time.After(100 * time.Millisecond):
	}
	letGo()
	select {
	case <-terminated:
	case <-time.After(10 * time.Second):
		t.Fatal("terminate did not return after the source did")
	}
	if !dbOpenAtEnd.Load() {
		t.Fatal("the database closed before the source returned")
	}
}

// A search that starts after the terminate began is not run: the database
// is about to close. The source is reported in Partial, not as zero hits.
func TestAggregateAfterTerminateRunsNoSource(t *testing.T) {
	app := testApp(t)
	// Register binds the runner at startup; do the same before the terminate.
	background.For(app, jobsPkg)
	app.(*tests.TestApp).Cleanup()
	called := false
	src := Source{
		Slug: "gizmos", Order: 5,
		Search: func(core.App, string, Query) (Result, error) {
			called = true
			return Result{}, nil
		},
	}
	resp := Aggregate(context.Background(), app, "u1", Query{Include: []string{"budget"}}, []Source{src})
	if called {
		t.Fatal("a source ran after the terminate")
	}
	if len(resp.Partial) != 1 || resp.Partial[0] != "gizmos" {
		t.Fatalf("partial = %v, want [gizmos]", resp.Partial)
	}
}
