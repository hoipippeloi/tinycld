import { describe, expect, it } from 'vitest'
import { applyComputed } from '../compute'
import { definitionSchema } from '../definition'
import fixture from '../fixtures/computed-fixture.json'
import { hostDefSchema } from '../host'

const def = definitionSchema.parse(fixture.definition)

describe('applyComputed against the shared fixture', () => {
    for (const c of fixture.cases) {
        it(c.name, () => {
            const out = applyComputed(def, undefined, c.values)
            const picked = Object.fromEntries(Object.keys(c.expect.values).map(k => [k, out[k]]))
            expect(picked).toEqual(c.expect.values)
            for (const key of c.expect.absent) expect(key in out).toBe(false)
        })
    }
})

describe('applyComputed', () => {
    it('does not mutate its input', () => {
        const values = { lines: [{ id: '1', qty: 1, rate: 2 }], tax_pct: 0, units: 1 }
        const copy = structuredClone(values)
        applyComputed(def, undefined, values)
        expect(values).toEqual(copy)
    })

    it('leaves a row that is not an object alone', () => {
        const out = applyComputed(def, undefined, { lines: ['junk'], tax_pct: 0, units: 0 })
        expect(out.lines).toEqual(['junk'])
        expect(out.subtotal).toBe(0)
    })
})

describe('applyComputed with host built-ins', () => {
    const host = hostDefSchema.parse({
        key: 'gizmos:invoice',
        label: 'Invoice',
        collection: 'gizmos_invoices',
        formColumn: 'form',
        fieldsColumn: 'fields',
        columns: ['title', 'subtotal', 'form', 'fields'],
        builtin: [
            { key: 'title', label: 'Title', kind: 'text', storage: 'column', required: true },
            {
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
            },
            {
                key: 'subtotal',
                label: 'Subtotal',
                kind: 'computed',
                storage: 'column',
                expression: { sumOf: [{ var: 'lines' }, 'amount'] },
            },
        ],
    })
    const hostDef = definitionSchema.parse({
        version: 1,
        pages: [{ key: 'main', title: 'Invoice' }],
        fields: ['title', 'lines', 'subtotal'].map(key => ({
            key,
            kind: 'builtin',
            page: 'main',
            label: key,
            width: 'full',
            required: false,
            hidden: false,
        })),
    })

    it('computes a built-in over a built-in table when the rows are present', () => {
        const out = applyComputed(hostDef, host, { lines: [{ id: 'a', qty: 2, rate: 7 }] })
        expect(out.subtotal).toBe(14)
        expect((out.lines as { amount: number }[])[0].amount).toBe(14)
    })

    it('skips it when the rows are not in the values', () => {
        const out = applyComputed(hostDef, host, { title: 'x', subtotal: 5 })
        expect(out.subtotal).toBe(5)
    })
})
