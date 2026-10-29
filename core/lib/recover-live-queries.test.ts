import { type Collection, createCollection, createLiveQueryCollection } from '@tanstack/db'
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
    const source = (name: string, status: string) => ({
        status,
        cleanup: vi.fn(async () => {
            calls.push(`cleanup ${name}`)
        }),
    })
    return { calls, make, source }
}

type Row = { id: string; label: string }
const ROWS: Row[] = [
    { id: 'row-1', label: 'first' },
    { id: 'row-2', label: 'second' },
]
let collectionCount = 0

// An on-demand source is ready at once and fails a load by rejecting its
// subset load, so only the reader that asked fails and the source stays ready.
function onDemandSourceFailsFirstLoad() {
    let loads = 0
    return createCollection<Row>({
        id: `on-demand-${++collectionCount}`,
        getKey: row => row.id,
        syncMode: 'on-demand',
        sync: {
            sync: ({ begin, write, commit, markReady }) => {
                markReady()
                return {
                    loadSubset: async () => {
                        loads += 1
                        if (loads === 1) {
                            throw Object.assign(new Error('forbidden'), { status: 403 })
                        }
                        begin()
                        for (const value of ROWS) write({ type: 'insert', value })
                        commit()
                    },
                }
            },
        },
    })
}

// A source whose first sync fails as a whole: the source itself is in error.
function sourceFailsFirstSync() {
    let attempts = 0
    return createCollection<Row>({
        id: `fails-once-${++collectionCount}`,
        getKey: row => row.id,
        sync: {
            sync: ({ begin, write, commit, markReady, markError }) => {
                attempts += 1
                if (attempts === 1) {
                    queueMicrotask(() => markError(new Error('load failed')))
                    return
                }
                begin()
                for (const value of ROWS) write({ type: 'insert', value })
                commit()
                markReady()
            },
        },
    })
}

function reader(source: Collection<Row>, name: string) {
    return createLiveQueryCollection({
        id: `${source.id}-${name}`,
        query: q => q.from({ row: source }),
        startSync: true,
    })
}

const subsetLoadFailed = (message: string) =>
    `[Live Query Error] Initial subset load failed: ${message}`
const sourceInError = (sourceId: string) =>
    `[Live Query Error] Source collection '${sourceId}' entered error state`
const sourceCleanedUp = (sourceId: string, queryId: string) =>
    `[Live Query Error] Source collection '${sourceId}' was manually cleaned up while live query '${queryId}' depends on it. Live queries prevent automatic GC, so this was likely a manual cleanup() call.`

// TanStack DB reports each live query failure with console.error. These tests
// cause failures on purpose: swallow exactly the lines they expect, let any
// other line print, and fail on an extra line or a missing one.
async function withExpectedConsoleErrors(expected: string[], body: () => Promise<void>) {
    const pending = [...expected]
    const unexpected: string[] = []
    const print = console.error.bind(console)
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const line = args.map(String).join(' ')
        const index = pending.indexOf(line)
        if (index === -1) {
            unexpected.push(line)
            print(...args)
            return
        }
        pending.splice(index, 1)
    })
    try {
        await body()
    } finally {
        spy.mockRestore()
    }
    expect(unexpected).toEqual([])
    expect(pending).toEqual([])
}

const rowsOf = (query: ReturnType<typeof reader>) =>
    [...query.values()].map(row => ({ id: row.id, label: row.label }))

describe('recoverLiveQueries', () => {
    it('cleans the queries, then a source in error, then preloads the queries', async () => {
        const { calls, make, source } = fakes()
        await recoverLiveQueries({
            queries: [make('q1'), make('q2')],
            sources: [source('s1', 'error')],
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

    it('never cleans a ready source, and still rebuilds the queries', async () => {
        const { calls, make, source } = fakes()
        const ready = source('s1', 'ready')
        await recoverLiveQueries({
            queries: [make('q1')],
            sources: [ready],
            onError: vi.fn(),
        })
        expect(ready.cleanup).not.toHaveBeenCalled()
        expect(calls).toEqual(['cleanup q1', 'preload q1'])
    })

    it('rebuilds the queries and nothing else when sources is omitted', async () => {
        const { calls, make } = fakes()
        const onError = vi.fn()
        await recoverLiveQueries({ queries: [make('q1'), make('q2')], onError })
        expect(calls).toEqual(['cleanup q1', 'cleanup q2', 'preload q1', 'preload q2'])
        expect(onError).not.toHaveBeenCalled()
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
        const { calls, make, source } = fakes()
        const boom = new Error('boom')
        const onError = vi.fn()
        await recoverLiveQueries({
            queries: [make('q1', { cleanup: vi.fn().mockRejectedValue(boom) }), make('q2')],
            sources: [source('s1', 'error')],
            onError,
        })
        expect(onError).toHaveBeenCalledWith(boom)
        expect(calls).toEqual(['cleanup q2', 'cleanup s1', 'preload q1', 'preload q2'])
    })

    it('recovers a failed on-demand reader and keeps the other reader of the same source working', async () => {
        const source = onDemandSourceFailsFirstLoad()
        await withExpectedConsoleErrors([subsetLoadFailed('forbidden')], async () => {
            const failed = reader(source, 'failed')
            await failed.preload().catch(() => undefined)
            await vi.waitFor(() => expect(failed.status).toBe('error'))
            const healthy = reader(source, 'healthy')
            await healthy.preload()
            await vi.waitFor(() => expect(rowsOf(healthy)).toEqual(ROWS))
            expect([failed.status, healthy.status, source.status]).toEqual([
                'error',
                'ready',
                'ready',
            ])

            const sourceCleanup = vi.spyOn(source, 'cleanup')
            const onError = vi.fn()
            await recoverLiveQueries({ queries: [failed], sources: [source], onError })
            // The recovered reader shows its rows only after the recovery is done,
            // so from here a change to the healthy reader would already show.
            await vi.waitFor(() => expect(rowsOf(failed)).toEqual(ROWS))

            expect(sourceCleanup).not.toHaveBeenCalled()
            expect(failed.status).toBe('ready')
            expect(healthy.status).toBe('ready')
            expect(rowsOf(healthy)).toEqual(ROWS)
            expect(onError).not.toHaveBeenCalled()
        })
    })

    it('recovers two readers of a failed source one after the other without breaking the first', async () => {
        const source = sourceFailsFirstSync()
        const expected = [
            sourceInError(source.id),
            sourceInError(source.id),
            // The first recovery cleans the source in error, which fails the second reader.
            sourceCleanedUp(source.id, `${source.id}-second`),
        ]
        await withExpectedConsoleErrors(expected, async () => {
            const first = reader(source, 'first')
            const second = reader(source, 'second')
            await Promise.allSettled([first.preload(), second.preload()])
            await vi.waitFor(() =>
                expect([first.status, second.status, source.status]).toEqual([
                    'error',
                    'error',
                    'error',
                ])
            )

            await recoverLiveQueries({ queries: [first], sources: [source], onError: vi.fn() })
            await vi.waitFor(() => expect(rowsOf(first)).toEqual(ROWS))
            expect(first.status).toBe('ready')

            await recoverLiveQueries({ queries: [second], sources: [source], onError: vi.fn() })
            // The second reader shows its rows only after its recovery is done,
            // so from here a break of the first reader would already show.
            await vi.waitFor(() => expect(rowsOf(second)).toEqual(ROWS))
            expect(second.status).toBe('ready')
            expect(first.status).toBe('ready')
            expect(rowsOf(first)).toEqual(ROWS)
        })
    })
})
