// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { BasicIndex, createCollection, disconnectRealtime } from 'pbtsdb/core'
import PocketBase, { BaseAuthStore } from 'pocketbase'
import { afterEach, describe, expect, it } from 'vitest'
import { fieldLabel, parseRecordLabel } from '../label'
import {
    type LabelCollection,
    type LabelSources,
    useLabelledRecord,
    useLabelledRecords,
} from '../use-labelled-records'

// A fictional package: a gizmo_tags row holds a code and a relation to the
// gizmo_families row whose name completes its label.
interface Family {
    id: string
    name: string
}
interface Tag {
    id: string
    code: string
    family: string
}
type GizmoSchema = {
    gizmo_families: { type: Family }
    gizmo_tags: { type: Tag; relations: { family: Family } }
}

const families: Family[] = [
    { id: 'f1', name: 'north.example' },
    { id: 'f2', name: 'south.example' },
]
const tags: Tag[] = [
    { id: 't1', code: 'sales', family: 'f1' },
    { id: 't2', code: 'sales', family: 'f2' },
    { id: 't3', code: 'info', family: 'f1' },
]

const tagLabel = parseRecordLabel({
    format: '{code}@{family.name}',
    relations: { family: 'gizmo_families' },
})

/**
 * Real pbtsdb collections over a PocketBase client whose record services
 * answer with every row and record each request's filter. The live query's own
 * `where` then narrows the rows on the client, the same evaluation it runs on
 * what the server returns, so a test sees both the filter the server was asked
 * for and the records the hook settles on. Realtime stays closed.
 */
function makeGizmo() {
    const requests: { collection: string; filter: string }[] = []
    const service = (collection: string, rows: object[]) => ({
        getFullList: async (opts?: { filter?: string }) => {
            requests.push({ collection, filter: opts?.filter ?? '' })
            return rows
        },
        getList: async (_page: number, _perPage: number, opts?: { filter?: string }) => {
            requests.push({ collection, filter: opts?.filter ?? '' })
            return { items: rows, totalItems: rows.length, totalPages: 1, page: 1, perPage: 500 }
        },
    })
    const services: Record<string, ReturnType<typeof service>> = {
        gizmo_families: service('gizmo_families', families),
        gizmo_tags: service('gizmo_tags', tags),
    }
    const pb = new PocketBase('http://127.0.0.1:9', new BaseAuthStore())
    Object.defineProperty(pb, 'collection', { value: (name: string) => services[name] })
    disconnectRealtime(pb)
    const newCollection = createCollection<GizmoSchema>(pb)
    const onDemand = {
        syncMode: 'on-demand',
        realtime: 'query',
        collectionOptions: { autoIndex: 'eager', defaultIndexType: BasicIndex },
    } as const
    const familyCollection = newCollection('gizmo_families', onDemand)
    const tagCollection = newCollection('gizmo_tags', {
        ...onDemand,
        relations: { family: familyCollection },
    })
    // The hooks take the app's registered stores, resolved by name at runtime;
    // these stand in for two of them.
    const sources: LabelSources = {
        collection: tagCollection as unknown as LabelCollection,
        related: familyCollection as unknown as LabelCollection,
    }
    return { sources, requests }
}

function names(records: { name: string }[]): string[] {
    return records.map(r => r.name).sort()
}

afterEach(() => cleanup())

describe('useLabelledRecords', () => {
    it('names every record by its own and related fields', async () => {
        const { sources } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecords(sources, tagLabel, ''))

        await waitFor(() => expect(result.current.records).toHaveLength(3))
        await waitFor(() =>
            expect(names(result.current.records)).toEqual([
                'info@north.example',
                'sales@north.example',
                'sales@south.example',
            ])
        )
    })

    it('finds a record by a word of its related field', async () => {
        const { sources, requests } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecords(sources, tagLabel, 'north'))

        await waitFor(() =>
            expect(names(result.current.records)).toEqual([
                'info@north.example',
                'sales@north.example',
            ])
        )
        expect(result.current.isReady).toBe(true)
        // Both halves of the search are asked of the server, not filtered from
        // a full download: the related name, then the tags it points at.
        const filters = requests.map(r => `${r.collection}: ${r.filter}`)
        expect(filters).toContain('gizmo_families: name ~ "%north%"')
        expect(filters.some(f => /^gizmo_tags: .*code ~ "%north%".*family = "f1"/.test(f))).toBe(
            true
        )
    })

    it('matches a whole typed label one part per field', async () => {
        const { sources } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecords(sources, tagLabel, 'sales@south'))

        await waitFor(() => expect(names(result.current.records)).toEqual(['sales@south.example']))
    })

    it('finds nothing for a word no field contains', async () => {
        const { sources } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecords(sources, tagLabel, 'west'))

        await waitFor(() => expect(result.current.isReady).toBe(true))
        expect(result.current.records).toEqual([])
    })

    it('searches the one display field of a collection with no declared label', async () => {
        const { sources, requests } = makeGizmo()
        const { result } = renderHook(() =>
            useLabelledRecords({ ...sources, related: undefined }, fieldLabel('code'), 'info')
        )

        await waitFor(() => expect(names(result.current.records)).toEqual(['info']))
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every(r => r.collection === 'gizmo_tags')).toBe(true)
    })
})

describe('useLabelledRecord', () => {
    it('names one record by id', async () => {
        const { sources } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecord(sources, tagLabel, 't2'))

        await waitFor(() =>
            expect(result.current).toEqual({ id: 't2', name: 'sales@south.example' })
        )
    })

    it('runs no request while nothing is selected', async () => {
        const { sources, requests } = makeGizmo()
        const { result } = renderHook(() => useLabelledRecord(sources, tagLabel, ''))

        await new Promise(resolve => setTimeout(resolve, 20))
        expect(result.current).toBeUndefined()
        expect(requests).toEqual([])
    })
})
