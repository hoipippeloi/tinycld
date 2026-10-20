package search

import (
	"context"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/background"
	"tinycld.org/core/logging"
)

// jobsPkg names the runner the source searches run on, and the logger.
const jobsPkg = "search"

var log = logging.ForPackage(jobsPkg)

// sourceTimeout bounds one package's search. The whole request is only as slow
// as its slowest source, so a package wedged on a lock or a pathological query
// must not hold the others hostage — it lands in Partial instead. A var so a
// test can shorten it.
var sourceTimeout = 5 * time.Second

// maxConcurrentSources caps parallel fan-out. Every source hits the same SQLite
// file, so unbounded parallelism buys nothing and costs connection contention.
const maxConcurrentSources = 4

// overFetchFactor asks each source for more rows than the caller wants.
// Cross-package ranking can only choose among rows it was given: if each source
// returned exactly Limit, a package whose hits all score poorly would still
// occupy its share of the merged page and push better rows out.
const overFetchFactor = 3

// defaultLimit matches the palette's page size.
const defaultLimit = 20

// maxLimit bounds the merged page.
const maxLimit = 100

// Aggregate runs q against every selected source concurrently and returns one
// merged, scored, ordered page.
//
// Two properties are contractual, inherited from the client-side fan-out this
// replaces: a source that fails contributes no rows but never fails the request
// (it is named in Partial), and ordering does not depend on which source
// answered first (sortRows tie-breaks on the source's Order).
func Aggregate(ctx context.Context, app core.App, userID string, q Query, sources []Source) Response {
	resp := Response{Rows: []Row{}, Counts: map[string]int{}}

	// FTS5 cannot subtract from nothing: a NOT-only MATCH is an error, not an
	// empty result. The client is expected to gate this too, but the endpoint
	// is reachable directly, so the invariant is enforced where it is relied on.
	if len(q.Include) == 0 || userID == "" || len(sources) == 0 {
		return resp
	}

	limit := q.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	perSource := Query{
		Include: q.Include,
		Exclude: q.Exclude,
		// Offset is deliberately NOT forwarded: paging happens on the merged
		// set, so every source must report from its first hit or the merge
		// would page each package independently and drop rows.
		Limit: limit * overFetchFactor,
	}

	type outcome struct {
		slug   string
		result Result
		err    error
	}
	results := make([]outcome, len(sources))

	// Each Search runs as a job on the app's runner, not a bare goroutine:
	// the request stops waiting at sourceTimeout, but the call runs on until
	// it returns, and the runner holds the app's terminate until then. A bare
	// goroutine could still be querying when the database closes.
	jobs := background.For(app, jobsPkg)

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrentSources)
	for i, src := range sources {
		wg.Add(1)
		go func(i int, src Source) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			// Ends at sourceTimeout, when the request ends, or (inside the
			// job, below) at terminate. Cancelled when the wait ends, so a
			// source still running is told to stop.
			sourceCtx, cancel := context.WithTimeout(ctx, sourceTimeout)
			defer cancel()

			done := make(chan outcome, 1)
			started := jobs.Run("search "+src.Slug, func(jobCtx context.Context) {
				searchCtx, stop := context.WithCancel(sourceCtx)
				defer stop()
				defer context.AfterFunc(jobCtx, stop)()
				// The recover must live in the goroutine that CALLS Search:
				// the runner's own recover would log the panic but leave done
				// empty, so the request would wait out sourceTimeout for a
				// source that has already failed.
				defer func() {
					if r := recover(); r != nil {
						done <- outcome{slug: src.Slug, err: errPanic(r)}
					}
				}()
				q := perSource
				q.Ctx = searchCtx
				res, err := src.Search(app, userID, q)
				done <- outcome{slug: src.Slug, result: res, err: err}
			})
			if !started {
				results[i] = outcome{slug: src.Slug, err: errTerminating}
				return
			}

			select {
			case o := <-done:
				results[i] = o
			case <-sourceCtx.Done():
				// The job may still be running, now with its context ended. It
				// writes only to its own buffered channel, and the runner
				// waits for it at terminate.
				results[i] = outcome{slug: src.Slug, err: sourceCtx.Err()}
			}
		}(i, src)
	}
	wg.Wait()

	orderBySlug := make(map[string]int, len(sources))
	for _, src := range sources {
		orderBySlug[src.Slug] = src.Order
	}

	var merged []Row
	for _, o := range results {
		if o.err != nil {
			// A failure must never read as an empty result set — that swallow
			// is what let a renamed column present as a silent zero before.
			log.WarnContext(ctx, "source failed", "pkgSlug", o.slug, "err", o.err)
			resp.Partial = append(resp.Partial, o.slug)
			continue
		}
		resp.Counts[o.slug] = o.result.Total
		if o.result.Total > len(o.result.Rows) {
			resp.Truncated = append(resp.Truncated, o.slug)
		}
		for _, row := range o.result.Rows {
			// Stamp the slug here rather than trusting the source, so a package
			// cannot label rows as another's.
			row.Slug = o.slug
			merged = append(merged, row)
		}
	}

	sortRows(merged, q.Include, orderBySlug)

	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= len(merged) {
		return resp
	}
	end := offset + limit
	if end > len(merged) {
		end = len(merged)
	}
	resp.Rows = merged[offset:end]
	return resp
}
