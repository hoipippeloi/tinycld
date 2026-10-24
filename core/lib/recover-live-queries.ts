interface Cleanable {
    cleanup(): Promise<void>
}

interface LiveQueryCollection extends Cleanable {
    preload(): Promise<void>
}

interface Recovery {
    // `useLiveQuery(...).collection`; a disabled query has none and is skipped.
    queries: (LiveQueryCollection | undefined)[]
    // The collections the queries read from.
    sources: Cleanable[]
    onError: (err: unknown) => void
}

/**
 * Takes live queries out of the error state.
 *
 * A live query that failed stays failed: a source `reload()` neither clears
 * it nor restarts it. TanStack DB's documented recovery (TanStack/db#923) is
 * to clean up the queries, then the sources they read, then preload the
 * queries again; the hook's subscription picks the rebuilt collection up.
 *
 * Every source in `sources` loses its rows until the queries reload them, so
 * pass only collections the calling screen owns the reading of.
 */
export async function recoverLiveQueries({ queries, sources, onError }: Recovery): Promise<void> {
    const live = queries.filter(q => q !== undefined)
    await settle(
        live.map(q => q.cleanup()),
        onError
    )
    await settle(
        sources.map(s => s.cleanup()),
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
