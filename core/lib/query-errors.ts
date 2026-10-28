import { captureException } from '@tinycld/core/lib/errors'

// reportQueryError is the global handler for a failed read: useQuery surfaces
// errors as state rather than throwing, so without it a read failure is silent
// (the component shows its own error UI, but nothing is logged). The queryKey
// is the grouping context. It does not import pocketbase.ts, which installs it.
export function reportQueryError(error: unknown, queryKey: readonly unknown[], _onSessionEnded: () => void) {
    captureException('query.error', error, { queryKey })
}
