import { describe, expect, it } from 'vitest'
import { definitionSchema, validateDefinitionForHost } from '../definition'
import { defaultDefinitionFor, hostDefSchema } from '../host'

function host(builtin: unknown[]) {
    return {
        key: 'gizmos:invoice',
        label: 'Invoice',
        collection: 'gizmos_invoices',
        formColumn: 'form',
        fieldsColumn: 'fields',
        columns: ['title', 'subtotal', 'total', 'form', 'fields'],
        builtin,
    }
}
const title = { key: 'title', label: 'Title', kind: 'text', storage: 'column', required: true }
const lines = {
    key: 'lines',
    label: 'Lines',
    kind: 'table',
    storage: 'rows',
    columns: [
        { key: 'qty', kind: 'number', label: 'Qty' },
        { key: 'rate', kind: 'number', label: 'Rate' },
        {
            key: 'amount',
            kind: 'computed',
            label: 'Amount',
            expression: { mul: [{ var: 'qty' }, { var: 'rate' }] },
        },
    ],
}
const subtotal = {
    key: 'subtotal',
    label: 'Subtotal',
    kind: 'computed',
    storage: 'column',
    expression: { sumOf: [{ var: 'lines' }, 'amount'] },
}

describe('host computed and table built-ins', () => {
    it('accepts a computed built-in over a table built-in', () => {
        expect(hostDefSchema.safeParse(host([title, lines, subtotal])).success).toBe(true)
    })

    it('accepts a constant-0 computed built-in', () => {
        const zero = { ...subtotal, expression: 0 }
        expect(hostDefSchema.safeParse(host([title, zero])).success).toBe(true)
    })

    it('requires an expression on a computed built-in and columns on a table', () => {
        const noExpr = { ...subtotal, expression: undefined }
        expect(hostDefSchema.safeParse(host([title, noExpr])).success).toBe(false)
        const noCols = { ...lines, columns: undefined }
        expect(hostDefSchema.safeParse(host([title, noCols])).success).toBe(false)
    })

    it('keeps computed in a column and tables in rows', () => {
        expect(
            hostDefSchema.safeParse(host([title, { ...subtotal, storage: 'rows' }])).success
        ).toBe(false)
        expect(
            hostDefSchema.safeParse(host([title, { ...lines, storage: 'column' }])).success
        ).toBe(false)
    })

    it('rejects an expression on a built-in that is not computed', () => {
        const bad = { ...title, expression: { var: 'x' } }
        expect(hostDefSchema.safeParse(host([bad])).success).toBe(false)
    })

    it('rejects a computed built-in that reads an unknown built-in or forms a cycle', () => {
        const ghost = { ...subtotal, expression: { var: 'ghost' } }
        expect(hostDefSchema.safeParse(host([title, ghost])).success).toBe(false)
        const a = {
            key: 'a',
            label: 'A',
            kind: 'computed',
            storage: 'column',
            expression: { var: 'b' },
        }
        const b = {
            key: 'b',
            label: 'B',
            kind: 'computed',
            storage: 'column',
            expression: { var: 'a' },
        }
        expect(hostDefSchema.safeParse(host([title, a, b])).success).toBe(false)
    })

    it('puts the new built-ins on the default definition', () => {
        const h = hostDefSchema.parse(host([title, lines, subtotal]))
        const def = defaultDefinitionFor(h)
        expect(def.fields.map(f => f.key)).toEqual(['title', 'lines', 'subtotal'])
        expect(definitionSchema.safeParse(def).success).toBe(true)
        expect(validateDefinitionForHost(definitionSchema.parse(def), h)).toEqual([])
    })

    it('lets a custom formula read a computed built-in and sum a table built-in', () => {
        const h = hostDefSchema.parse(host([title, lines, subtotal]))
        const def = definitionSchema.parse({
            ...defaultDefinitionFor(h),
            fields: [
                ...defaultDefinitionFor(h).fields,
                {
                    key: 'half',
                    kind: 'computed',
                    page: 'main',
                    label: 'Half',
                    width: 'full',
                    required: false,
                    hidden: false,
                    decimals: 0,
                    expression: { div: [{ var: 'subtotal' }, 2] },
                },
                {
                    key: 'rows_count',
                    kind: 'computed',
                    page: 'main',
                    label: 'Rows',
                    width: 'full',
                    required: false,
                    hidden: false,
                    decimals: 0,
                    expression: { count: [{ var: 'lines' }] },
                },
            ],
        })
        expect(validateDefinitionForHost(def, h)).toEqual([])
    })

    it('flags a custom formula that sums a column the host table lacks', () => {
        const h = hostDefSchema.parse(host([title, lines, subtotal]))
        const base = defaultDefinitionFor(h)
        const def = definitionSchema.parse({
            ...base,
            fields: [
                ...base.fields,
                {
                    key: 'bad',
                    kind: 'computed',
                    page: 'main',
                    label: 'Bad',
                    width: 'full',
                    required: false,
                    hidden: false,
                    decimals: 0,
                    expression: { sumOf: [{ var: 'lines' }, 'nope'] },
                },
            ],
        })
        expect(JSON.stringify(validateDefinitionForHost(def, h))).toContain('unknown column nope')
    })
})
