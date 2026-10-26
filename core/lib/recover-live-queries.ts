interface LiveQueryCollection {
    cleanup(): Promise<void>
    preload(): Promise<void>
}

interface Source {
    status: string
    cleanup(): Promise<void>
}

interface Recovery {
    // `useLiveQuery(...).collection`; a disabled query has none and is skipped.
    queries: (LiveQueryCollection | undefined)[]
    // The collections the queries read from. Only those in the error state are
    // cleaned up.
    sources?: Source[]
    onError: (err: unknown) => void
}

/**
 * Takes live queries out of the error state.
 *
 * A live query that failed stays failed: a source `reload()` neither clears
 * it nor restarts it. So the queries are cleaned up and preloaded again; the
 * hook's subscription picks the rebuilt collection up.
 *
 * A source that is ready is left alone. Cleaning a source fatally errors
 * every other live query that reads it, and only that reader's own restart
 * clears the error. A failed on-demand load fails only the live query that
 * asked for it, while the source stays ready, so restarting the query is
 * enough.
 *
 * A source in the error state is cleaned up between the two steps, because
 * only a restart takes a source out of error. Its other readers are then
 * fatally errored too and need their own retry.
 */
export async function recoverLiveQueries({
    queries,
    sources = [],
    onError,
}: Recovery): Promise<void> {
    const live = queries.filter(q => q !== undefined)
    await settle(
        live.map(q => q.cleanup()),
        onError
    )
    await settle(
        sources.filter(s => s.status === 'error').map(s => s.cleanup()),
        onError
    )
    await settle(
        live.map(q => q.preload()),
        onError
    )
}

// allSettled so one failure cannot hide the others; a failure goes to onError
// because the screen reads the outcome from the query's own isError.
async function settle(work: Promise<void>[], onError: (err: unknown) => void) {
    const results = await Promise.allSettled(work)
    for (const result of results) {
        if (result.status === 'rejected') onError(result.reason)
    }
}
