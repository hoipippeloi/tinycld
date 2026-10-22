import { describe, expect, it } from 'vitest'
import type { TableColumn } from '../definition'
import {
    completeTableRows,
    moveRow,
    newTableRow,
    planTableWrites,
    type TableRowMapper,
    tableRowsOf,
} from '../table-rows'

const columns: TableColumn[] = [
    { key: 'label', kind: 'text', label: 'Label', required: false, hidden: false },
    { key: 'qty', kind: 'number', label: 'Qty', required: false, hidden: false },
    { key: 'done', kind: 'toggle', label: 'Done', required: false, hidden: true },
    {
        key: 'double',
        kind: 'computed',
        label: 'Double',
        required: false,
        hidden: false,
        decimals: 0,
        expression: { mul: [{ var: 'qty' }, 2] },
    },
]

describe('newTableRow', () => {
    it('holds null in every editable column, hidden ones included, and nothing computed', () => {
        expect(newTableRow(columns, 'r1')).toEqual({ id: 'r1', label: null, qty: null, done: null })
    })
})

describe('completeTableRows', () => {
    it('adds the missing cells, reads a cleared number as null, and keeps other keys', () => {
        const out = completeTableRows(columns, [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', qty: '', extra: 1, double: 9 },
        ])
        expect(out).toEqual([
            { id: 'a', label: 'A', qty: null, done: null },
            { id: 'b', label: 'B', qty: null, done: null, extra: 1, double: 9 },
        ])
    })

    it('keeps a cleared text cell as an empty string', () => {
        expect(completeTableRows(columns, [{ id: 'a', label: '' }])[0].label).toBe('')
    })
})

describe('moveRow', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    it('moves a row one place up or down', () => {
        expect(moveRow(rows, 'b', -1).map(r => r.id)).toEqual(['b', 'a', 'c'])
        expect(moveRow(rows, 'b', 1).map(r => r.id)).toEqual(['a', 'c', 'b'])
    })

    it('returns the same array at an edge or for an unknown id', () => {
        expect(moveRow(rows, 'a', -1)).toBe(rows)
        expect(moveRow(rows, 'c', 1)).toBe(rows)
        expect(moveRow(rows, 'zz', 1)).toBe(rows)
    })
})

interface Line {
    id: string
    position: number
    item: string
}

const mapper: TableRowMapper<Line, { position: number; item: string }> = {
    toRow: line => ({ item: line.item }),
    positionOf: line => line.position,
    toRecord: (row, position) => ({ position, item: String(row.item ?? '') }),
}

describe('tableRowsOf', () => {
    it('orders by position, then id, and takes the id from the record', () => {
        const rows = tableRowsOf(
            [
                { id: 'z', position: 1, item: 'Z' },
                { id: 'b', position: 0, item: 'B' },
                { id: 'a', position: 0, item: 'A' },
            ],
            mapper
        )
        expect(rows).toEqual([
            { id: 'a', item: 'A' },
            { id: 'b', item: 'B' },
            { id: 'z', item: 'Z' },
        ])
    })
})

describe('planTableWrites', () => {
    const a = { id: 'a', item: 'A' }
    const b = { id: 'b', item: 'B' }
    const c = { id: 'c', item: 'C' }

    it('inserts every row of a new record at its index', () => {
        expect(planTableWrites([], [a, b])).toEqual({
            insert: [
                { row: a, position: 0 },
                { row: b, position: 1 },
            ],
            update: [],
            remove: [],
        })
    })

    it('writes nothing when nothing changed', () => {
        expect(planTableWrites([a, b], [{ ...a }, { ...b }])).toEqual({
            insert: [],
            update: [],
            remove: [],
        })
    })

    it('updates a row whose cell or index changed, and removes a dropped row', () => {
        const edited = { ...c, item: 'C2' }
        expect(planTableWrites([a, b, c], [edited, a])).toEqual({
            insert: [],
            update: [
                { row: edited, position: 0 },
                { row: a, position: 1 },
            ],
            remove: ['b'],
        })
    })

    it('treats a cell that went from missing to null as changed', () => {
        expect(planTableWrites([a], [{ ...a, qty: null }]).update).toHaveLength(1)
    })
})
