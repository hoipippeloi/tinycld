import { withNativeUploadBodies } from '@tinycld/core/lib/native-upload-body'
import { type Fetch, withReadOnlyRetry } from '@tinycld/core/lib/read-only-retry'

// The one fetch every call to OUR server should go through. It has the same
// signature as the platform `fetch`, so it drops into any existing call site
// unchanged, and it retries a briefly-unavailable server the same way
// pbtsdb's REST calls do (see read-only-retry.ts) — without this, a direct
// `fetch` call sees the 503 once and fails where a pbtsdb-backed read or
// write would have quietly recovered.
//
// On native it also sends a one-file multipart upload through
// expo-file-system's native uploader, which streams the file from disk; the
// native global fetch (expo/fetch) would hold the whole body in JS memory. See
// streamed-upload.ts. That happens inside the retry, so a retried upload
// streams the file again.
//
// `globalThis.fetch` is read per call, not captured at module load, so a test
// or polyfill that replaces it later still takes effect.
export const serverFetch: Fetch = withReadOnlyRetry(
    withUnreachableMarked(withNativeUploadBodies((url, config) => fetch(url, config)))
)

// ServerUnreachableError is a fetch that never reached the server: the device
// is offline or the server is down. A bug can also throw a TypeError, so the
// platform's own error ("Network request failed", "Failed to fetch") cannot
// tell the two apart; marking the failure here can. The message is the
// platform's, so text shown to the user does not change.
export class ServerUnreachableError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), { cause })
        this.name = 'ServerUnreachableError'
    }
}

function isAbort(error: unknown): boolean {
    return (error as { name?: unknown } | null)?.name === 'AbortError'
}

// withUnreachableMarked rethrows a rejected fetch as ServerUnreachableError.
// An abort is the caller's own cancel and passes through unchanged.
export function withUnreachableMarked(fetchImpl: Fetch): Fetch {
    return (url, config) =>
        fetchImpl(url, config).catch((error: unknown) => {
            if (isAbort(error)) throw error
            throw new ServerUnreachableError(error)
        })
}
