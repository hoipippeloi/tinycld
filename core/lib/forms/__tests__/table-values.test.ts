import { describe, expect, it } from 'vitest'
import type { FormDefinition } from '../definition'
import type { FormHostDef } from '../host'
import { evaluate, type FormValues } from '../logic'
import {
    buildSchema,
    computedKeysOf,
    emptyTablesOf,
    isHostTable,
    mergeValues,
    prepareValues,
    tableColumnsOf,
} from '../values'
import { fieldOf, gizmos, orderDefinition, orderHost, partsDefinition } from './table-fixtures'

const ctx = { today: '2026-01-01', userId: 'u' }

function schemaOf(def: FormDefinition, host: FormHostDef, values: FormValues) {
    return buildSchema(def, host, evaluate(def, values, ctx))
}

function issuesOf(def: FormDefinition, host: FormHostDef, values: FormValues) {
    const result = schemaOf(def, host, values).safeParse(values)
    if (result.success) return []
    return result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
}

describe('table cell validation', () => {
    it('names a blank required cell by its column label', () => {
        const issues = issuesOf(partsDefinition, gizmos, {
            parts: [{ id: 'r', label: null, qty: null }],
        })
        expect(issues).toEqual(
            expect.arrayContaining([
                { path: 'parts.0.label', message: 'Label is required' },
                { path: 'parts.0.qty', message: 'Qty is required' },
            ])
        )
    })

    it('reads a cleared number cell as no value', () => {
        const values = { name: 'N', lines: [{ id: 'r', item: 'x', qty: '', rate: 2 }] }
        expect(issuesOf(orderDefinition, orderHost, values)).toEqual([])
        const parsed = schemaOf(orderDefinition, orderHost, values).parse(values)
        expect(parsed.lines).toEqual([{ id: 'r', item: 'x', qty: null, rate: 2 }])
    })

    it('validates the rows of a host table, which are not submitted with the record', () => {
        const issues = issuesOf(orderDefinition, orderHost, {
            name: 'N',
            lines: [{ id: 'r', item: '', qty: 1 }],
        })
        expect(issues).toEqual([{ path: 'lines.0.item', message: 'Item is required' }])
    })
})

describe('table helpers', () => {
    it('tells a host table from a custom one and finds their columns', () => {
        expect(isHostTable(orderHost, fieldOf(orderDefinition, 'lines'))).toBe(true)
        expect(isHostTable(gizmos, fieldOf(partsDefinition, 'parts'))).toBe(false)
        expect(
            tableColumnsOf(orderHost, fieldOf(orderDefinition, 'lines'))?.map(c => c.key)
        ).toEqual(['item', 'qty', 'rate', 'amount'])
        expect(tableColumnsOf(gizmos, fieldOf(partsDefinition, 'parts'))?.length).toBe(6)
        expect(tableColumnsOf(orderHost, fieldOf(orderDefinition, 'name'))).toBeUndefined()
    })

    it('seeds every table with no rows', () => {
        expect(emptyTablesOf(orderDefinition, orderHost)).toEqual({ lines: [] })
        expect(emptyTablesOf(partsDefinition, gizmos)).toEqual({ parts: [] })
    })

    it('lists the computed keys', () => {
        expect(computedKeysOf(orderDefinition, orderHost)).toEqual(['subtotal'])
        expect(computedKeysOf(partsDefinition, gizmos)).toEqual(['total_qty'])
    })

    it('prepares a cleared number cell as null and fills computed cells', () => {
        const out = prepareValues(orderDefinition, orderHost, {
            name: 'N',
            lines: [
                { id: 'r', item: 'x', qty: '', rate: 2 },
                { id: 's', item: 'y', qty: 3, rate: 1.5 },
            ],
        })
        expect(out.lines).toEqual([
            { id: 'r', item: 'x', qty: null, rate: 2, amount: 0 },
            { id: 's', item: 'y', qty: 3, rate: 1.5, amount: 4.5 },
        ])
        expect(out.subtotal).toBe(4.5)
    })
})

describe('mergeValues with tables', () => {
    it('leaves a host table the caller did not load undefined, and its total as stored', () => {
        const values = mergeValues(orderHost, orderDefinition, { name: 'N', subtotal: 9 })
        expect(values.lines).toBeUndefined()
        expect(prepareValues(orderDefinition, orderHost, values).subtotal).toBe(9)
    })

    it('completes the rows of host and custom tables', () => {
        const host = mergeValues(
            orderHost,
            orderDefinition,
            { name: 'N' },
            {},
            {
                lines: [{ id: 'a', item: 'x' }],
            }
        )
        expect(host.lines).toEqual([{ id: 'a', item: 'x', qty: null, rate: null }])
        const custom = mergeValues(gizmos, partsDefinition, {
            fields: { parts: [{ id: 'a', label: 'A' }] },
        })
        expect(custom.parts).toEqual([
            { id: 'a', label: 'A', qty: null, done: null, due: null, size: null },
        ])
    })
})
