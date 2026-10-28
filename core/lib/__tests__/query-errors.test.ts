import { ClientResponseError } from 'pocketbase'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportQueryError } from '@tinycld/core/lib/query-errors'
import { ServerUnreachableError } from '@tinycld/core/lib/server-fetch'
import { captureExceptionToSentry } from '@tinycld/core/lib/sentry'

vi.mock('@tinycld/core/lib/sentry', () => ({
    captureExceptionToSentry: vi.fn(),
    addBreadcrumbToSentry: vi.fn(),
    captureMessageToSentry: vi.fn(),
}))

const queryKey = ['org-info']

function responseError(status: number, originalError?: unknown) {
    return new ClientResponseError({ url: '/api/x', status, response: {}, originalError })
}

describe('reportQueryError', () => {
    beforeEach(() => {
        vi.mocked(captureExceptionToSentry).mockClear()
    })

    it('ends the session on a 401 instead of reporting it', () => {
        const onSessionEnded = vi.fn()
        reportQueryError(responseError(401), queryKey, onSessionEnded)
        expect(onSessionEnded).toHaveBeenCalledTimes(1)
        expect(captureExceptionToSentry).not.toHaveBeenCalled()
    })

    it('does not report a fetch that could not reach the server', () => {
        reportQueryError(new ServerUnreachableError(new TypeError('Network request failed')), queryKey, vi.fn())
        reportQueryError(
            responseError(0, new ServerUnreachableError(new TypeError('Failed to fetch'))),
            queryKey,
            vi.fn()
        )
        expect(captureExceptionToSentry).not.toHaveBeenCalled()
    })

    it('reports a bug and a server error', () => {
        reportQueryError(new TypeError('x.split is not a function'), queryKey, vi.fn())
        reportQueryError(responseError(500), queryKey, vi.fn())
        expect(captureExceptionToSentry).toHaveBeenCalledTimes(2)
    })
})
