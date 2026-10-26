// @vitest-environment happy-dom
import {
    createCollection as createLocalCollection,
    eq,
    localOnlyCollectionOptions,
} from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRecord } from '@tinycld/core/lib/use-record'
import { createCollection, disconnectRealtime } from 'pbtsdb/core'
import PocketBase, { BaseAuthStore } from 'pocketbase'
import { afterEach, describe, expect, it } from 'vitest'

interface Note {
    id: string
    owner: string
    title: string
}

const rows: Note[] = [
    { id: 'n1', owner: 'u1', title: 'First' },
    { id: 'n2', owner: 'u1', title: 'Second' },
    { id: 'n3', owner: 'u2', title: 'Elsewhere' },
]

function matching(filter: string | undefined): Note[] {
    if (!filter) return rows
    return rows.filter(row =>
        Object.entries(row).some(([field, value]) => filter.includes(`${field} = "${value}"`))
    )
}

/**
 * A real pbtsdb collection over a PocketBase client whose record service
 * answers from `rows` and counts every request, so a test can tell a lookup
 * served from the store from one that went to the server. Realtime stays
 * closed; only the fetch path is under test.
 */
function makeNotes() {
    const requests: string[] = []
    const service = {
        getFullList: async (opts?: { filter?: string }) => {
            requests.push(opts?.filter ?? '')
            return matching(opts?.filter)
        },
        getList: async (_page: number, _perPage: number, opts?: { filter?: string }) => {
            requests.push(opts?.filter ?? '')
            const items = matching(opts?.filter)
            return { items, totalItems: items.length, totalPages: 1, page: 1, perPage: 500 }
        },
    }
    const pb = new PocketBase('http://127.0.0.1:9', new BaseAuthStore())
    Object.defineProperty(pb, 'collection', { value: () => service })
    disconnectRealtime(pb)
    const notes = createCollection<{ notes: { type: Note } }>(pb)('notes', {
        syncMode: 'on-demand',
        realtime: 'query',
    })
    return { notes, requests }
}

type Item = { id: string; label: string }

let localCount = 0

function localItems(name: string, initialData: Item[]) {
    return createLocalCollection(
        localOnlyCollectionOptions<Item>({
            id: `use-record-${name}-${++localCount}`,
            getKey: (item: Item) => item.id,
            initialData,
        })
    )
}

afterEach(() => cleanup())

describe('useRecord', () => {
    it('reads a row another live query holds from the store, with no request', async () => {
        const { notes, requests } = makeNotes()
        const list = renderHook(() =>
            useLiveQuery(q => q.from({ n: notes }).where(({ n }) => eq(n.owner, 'u1')))
        )
        await waitFor(() => expect(list.result.current.data).toHaveLength(2))
        const before = requests.length

        const { result } = renderHook(() => useRecord(notes, 'n2'))

        await waitFor(() => expect(result.current.record?.title).toBe('Second'))
        expect(result.current.isLoading).toBe(false)
        expect(requests).toHaveLength(before)
    })

    it('fetches a row the store does not hold', async () => {
        const { notes, requests } = makeNotes()

        const { result } = renderHook(() => useRecord(notes, 'n3'))

        await waitFor(() => expect(result.current.record?.title).toBe('Elsewhere'))
        expect(requests).toHaveLength(1)
    })

    // useRecord names its live query with an explicit key, which is the whole
    // identity of the query for the life of one hook. Two hooks mounted side by
    // side have separate identities anyway, so the swap and rerender steps are
    // what guard the key: a key that left out the id or the collection would
    // keep serving the old record.
    it('keeps two records of one collection apart, also when their ids swap', async () => {
        const widgets = localItems('widgets', [
            { id: 'a', label: 'widget a' },
            { id: 'b', label: 'widget b' },
        ])
        const { result, rerender } = renderHook(
            ({ first, second }) => ({
                first: useRecord(widgets, first),
                second: useRecord(widgets, second),
            }),
            { initialProps: { first: 'a', second: 'b' } }
        )
        await waitFor(() => {
            expect(result.current.first.record?.label).toBe('widget a')
            expect(result.current.second.record?.label).toBe('widget b')
        })

        rerender({ first: 'b', second: 'a' })
        await waitFor(() => {
            expect(result.current.first.record?.label).toBe('widget b')
            expect(result.current.second.record?.label).toBe('widget a')
        })
    })

    it('follows a changed id to the new record, and back', async () => {
        const widgets = localItems('widgets', [
            { id: 'a', label: 'widget a' },
            { id: 'b', label: 'widget b' },
        ])
        const { result, rerender } = renderHook(({ id }) => useRecord(widgets, id), {
            initialProps: { id: 'a' },
        })
        await waitFor(() => expect(result.current.record?.label).toBe('widget a'))

        rerender({ id: 'b' })
        await waitFor(() => expect(result.current.record?.label).toBe('widget b'))

        rerender({ id: 'a' })
        await waitFor(() => expect(result.current.record?.label).toBe('widget a'))
    })

    // The side-by-side hooks have separate identities anyway; the rerender of
    // one hook onto another collection is what guards the key.
    it("returns each collection's own row for the same id", async () => {
        const widgets = localItems('widgets', [{ id: 'same', label: 'the widget' }])
        const gadgets = localItems('gadgets', [{ id: 'same', label: 'the gadget' }])

        const sideBySide = renderHook(() => ({
            widget: useRecord(widgets, 'same'),
            gadget: useRecord(gadgets, 'same'),
        }))
        await waitFor(() => {
            expect(sideBySide.result.current.widget.record?.label).toBe('the widget')
            expect(sideBySide.result.current.gadget.record?.label).toBe('the gadget')
        })

        const { result, rerender } = renderHook(({ collection }) => useRecord(collection, 'same'), {
            initialProps: { collection: widgets },
        })
        await waitFor(() => expect(result.current.record?.label).toBe('the widget'))

        rerender({ collection: gadgets })
        await waitFor(() => expect(result.current.record?.label).toBe('the gadget'))

        rerender({ collection: widgets })
        await waitFor(() => expect(result.current.record?.label).toBe('the widget'))
    })

    it('is disabled for an empty or missing id: no record, not loading, no request', async () => {
        const { notes, requests } = makeNotes()
        const { result, rerender } = renderHook(
            ({ id }: { id: string | null | undefined }) => useRecord(notes, id),
            { initialProps: { id: '' as string | null | undefined } }
        )
        expect(result.current).toEqual({ record: undefined, isLoading: false })

        rerender({ id: null })
        expect(result.current).toEqual({ record: undefined, isLoading: false })

        rerender({ id: undefined })
        expect(result.current).toEqual({ record: undefined, isLoading: false })

        // The request log is ordered: the first request is the one for n1, so
        // no request for an empty id went out before it.
        rerender({ id: 'n1' })
        await waitFor(() => expect(result.current.record?.title).toBe('First'))
        expect(requests).toEqual(['id = "n1"'])

        // Leaving a real id for an empty one drops the record it held.
        rerender({ id: '' })
        expect(result.current).toEqual({ record: undefined, isLoading: false })

        // The record is undefined at once, so waiting on it proves no settle.
        // A second real id gives the ordered proof: its request comes directly
        // after n1's, so no request for the empty id went out between them.
        rerender({ id: 'n2' })
        await waitFor(() => expect(result.current.record?.title).toBe('Second'))
        expect(requests).toEqual(['id = "n1"', 'id = "n2"'])
    })

    it('re-renders when the held row changes', async () => {
        const widgets = localItems('widgets', [{ id: 'a', label: 'before' }])
        const { result } = renderHook(() => useRecord(widgets, 'a'))
        await waitFor(() => expect(result.current.record?.label).toBe('before'))

        await act(async () => {
            await widgets.update('a', draft => {
                draft.label = 'after'
            }).isPersisted.promise
        })
        await waitFor(() => expect(result.current.record?.label).toBe('after'))
    })
})
