import { describe, expect, it } from 'vitest'
import { definitionSchema } from '../definition'
import fixture from '../fixtures/computed-fixture.json'
import { hostDefSchema } from '../host'
import { evaluate } from '../logic'
import { buildSchema, mergeValues, splitValues } from '../values'

const def = definitionSchema.parse(fixture.definition)
const host = hostDefSchema.parse({
    key: 'gizmos:widget',
    label: 'Widget',
    collection: 'gizmos_widgets',
    formColumn: 'form',
    fieldsColumn: 'fields',
    columns: ['name', 'form', 'fields'],
    builtin: [{ key: 'name', label: 'Name', kind: 'text', storage: 'column' }],
})
const ctx = { today: '2026-01-01', userId: 'u' }

function parse(values: Record<string, unknown>) {
    const state = evaluate(def, values, ctx)
    return buildSchema(def, host, state).safeParse(values)
}

describe('buildSchema with tables and computed fields', () => {
    it('accepts valid rows and ignores computed fields', () => {
        const r = parse({
            lines: [{ id: '1', qty: 2, rate: 5, taxable: true, amount: 10 }],
            subtotal: 'whatever',
            tax_pct: 5,
        })
        expect(r.success).toBe(true)
    })

    it('rejects a row without an id and a text where a number belongs', () => {
        expect(parse({ lines: [{ qty: 1 }] }).success).toBe(false)
        expect(parse({ lines: [{ id: '1', qty: 'two' }] }).success).toBe(false)
    })
})

describe('splitValues and mergeValues for computed and tables', () => {
    it('routes custom computed and table values to the JSON column', () => {
        const out = splitValues(host, def, {
            subtotal: 5,
            lines: [{ id: '1', qty: 1 }],
            tax_pct: 3,
        })
        expect(out.fields).toEqual({ subtotal: 5, lines: [{ id: '1', qty: 1 }], tax_pct: 3 })
        expect(out.columns).toEqual({})
        expect(out.tables).toEqual({})
    })

    it('round-trips through the record', () => {
        const record = { fields: { subtotal: 5, lines: [{ id: '1', qty: 1 }] } }
        const values = mergeValues(host, def, record)
        expect(values.subtotal).toBe(5)
        expect(values.lines).toEqual([{ id: '1', qty: 1, rate: null, taxable: null }])
    })
})

describe('host table built-ins', () => {
    const tableHost = hostDefSchema.parse({
        key: 'gizmos:invoice',
        label: 'Invoice',
        collection: 'gizmos_invoices',
        formColumn: 'form',
        fieldsColumn: 'fields',
        columns: ['subtotal', 'form', 'fields'],
        builtin: [
            {
                key: 'lines',
                label: 'Lines',
                kind: 'table',
                storage: 'rows',
                columns: [{ key: 'qty', kind: 'number', label: 'Qty' }],
            },
            {
                key: 'subtotal',
                label: 'Subtotal',
                kind: 'computed',
                storage: 'column',
                expression: { sumOf: [{ var: 'lines' }, 'qty'] },
            },
        ],
    })
    const tableDef = definitionSchema.parse({
        version: 1,
        pages: [{ key: 'main', title: 'Invoice' }],
        fields: ['lines', 'subtotal'].map(key => ({
            key,
            kind: 'builtin',
            page: 'main',
            label: key,
            width: 'full',
            required: false,
            hidden: false,
        })),
    })

    it('puts table rows in tables and a computed built-in in columns', () => {
        const out = splitValues(tableHost, tableDef, {
            lines: [{ id: 'a', qty: 2 }],
            subtotal: 2,
        })
        expect(out.tables).toEqual({ lines: [{ id: 'a', qty: 2 }] })
        expect(out.columns).toEqual({ subtotal: 2 })
        expect(out.rows).toEqual({})
    })

    it('merges rows back from the tables argument', () => {
        const values = mergeValues(
            tableHost,
            tableDef,
            { subtotal: 2 },
            {},
            { lines: [{ id: 'a', qty: 2 }] }
        )
        expect(values.lines).toEqual([{ id: 'a', qty: 2 }])
    })
})
