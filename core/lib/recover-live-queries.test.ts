import { describe, expect, it, vi } from 'vitest'
import { recoverLiveQueries } from './recover-live-queries'

function fakes() {
    const calls: string[] = []
    const make = (name: string, extra: object = {}) => ({
        cleanup: vi.fn(async () => {
            calls.push(`cleanup ${name}`)
        }),
        preload: vi.fn(async () => {
            calls.push(`preload ${name}`)
        }),
        ...extra,
    })
    return { calls, make }
}

describe('recoverLiveQueries', () => {
    it('cleans the queries, then the sources, then preloads the queries', async () => {
        const { calls, make } = fakes()
        await recoverLiveQueries({
            queries: [make('q1'), make('q2')],
            sources: [make('s1')],
            onError: vi.fn(),
        })
        expect(calls).toEqual([
            'cleanup q1',
            'cleanup q2',
            'cleanup s1',
            'preload q1',
            'preload q2',
        ])
    })

    it('skips a disabled query', async () => {
        const { calls, make } = fakes()
        await recoverLiveQueries({
            queries: [undefined, make('q1')],
            sources: [],
            onError: vi.fn(),
        })
        expect(calls).toEqual(['cleanup q1', 'preload q1'])
    })

    it('reports a failure and still runs the remaining steps', async () => {
        const { calls, make } = fakes()
        const boom = new Error('boom')
        const onError = vi.fn()
        await recoverLiveQueries({
            queries: [make('q1', { cleanup: vi.fn().mockRejectedValue(boom) }), make('q2')],
            sources: [make('s1')],
            onError,
        })
        expect(onError).toHaveBeenCalledWith(boom)
        expect(calls).toEqual(['cleanup q2', 'cleanup s1', 'preload q1', 'preload q2'])
    })
})
