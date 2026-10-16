import type { Context, InitialQueryBuilder, QueryBuilder } from '@tanstack/db'
import { type LiveQueryKey, useLiveQuery } from '@tanstack/react-db'
import { useAuth } from '@tinycld/core/lib/auth'

/**
 * A live query filtered to the current user's own rows.
 *
 * Single-org deployment: the process IS one org, so there is nothing to scope
 * by except the caller's identity. Every use of this hook filters "my own rows"
 * — an owner/user/author FK pointing straight at `users`.
 *
 * `userId` is guaranteed non-empty inside the callback: with no authenticated
 * user the query is disabled rather than run with a blank id. That matters
 * because a blank id is not a harmless no-op — it is a real value that matches
 * rows whose FK is empty. `useLabels` is the worked example: it filters
 * `or(eq(labels.user, ''), eq(labels.user, userId))`, where empty-string user
 * means "shared label", so a blank `userId` would silently widen the query
 * rather than return nothing.
 *
 * `useAuth` is read with `throwIfAnon: false` because a query-bearing surface
 * can render outside the auth gate (a /p/* share route), where anonymous is the
 * normal case and throwing would turn the screen into an error boundary.
 *
 * Use plain `useLiveQuery`, in its object form, when a query does not filter
 * by the caller.
 */
export function useMyLiveQuery<TContext extends Context>(
    queryFn: (
        q: InitialQueryBuilder,
        me: { userId: string }
    ) => QueryBuilder<TContext> | undefined | null,
    /**
     * `{ queryKey }` gives the query an explicit identity, for a query on a
     * hot render path: without it, react-db rebuilds and hashes the query on
     * every render to find out whether it changed. The key must name every
     * value the query captures, or a change to an unnamed value does not
     * re-run it. The user id is added to the key here.
     *
     * An array is the deprecated deps list. It has no effect; it is kept only
     * so packages that still pass it compile unchanged — they release
     * separately from core.
     */
    options?: { queryKey: LiveQueryKey } | unknown[]
) {
    const { user } = useAuth({ throwIfAnon: false })
    const userId = user?.id ?? ''
    const queryKey =
        options && !Array.isArray(options) ? ['my', userId, ...options.queryKey] : undefined

    return useLiveQuery({ queryKey, query: q => (userId ? queryFn(q, { userId }) : null) })
}
