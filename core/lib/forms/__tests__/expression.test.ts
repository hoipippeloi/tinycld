import { describe, expect, it } from 'vitest'
import {
    type ComputeExpr,
    computeExprSchema,
    evalCompute,
    exprRefs,
    orderNodes,
    roundHalfAway,
} from '../expression'

describe('computeExprSchema', () => {
    it('accepts every operator', () => {
        const exprs: unknown[] = [
            5,
            { var: 'qty' },
            { add: [1, { var: 'a' }] },
            { sub: [{ var: 'a' }, 1] },
            { mul: [2, 3, 4] },
            { div: [1, 2] },
            { round: [{ var: 'a' }, 2] },
            { min: [1, 2] },
            { max: [1, 2] },
            { sumOf: [{ var: 'lines' }, 'amount'] },
            { count: [{ var: 'lines' }] },
        ]
        for (const e of exprs) expect(computeExprSchema.safeParse(e).success).toBe(true)
    })

    it('rejects unknown operators, extra keys, wrong arity and bad decimals', () => {
        const bad: unknown[] = [
            { pow: [2, 3] },
            { var: 'qty', extra: 1 },
            { add: [1] },
            { sub: [1, 2, 3] },
            { round: [1, 7] },
            { round: [1, -1] },
            { round: [1, 0.5] },
            { sumOf: [{ var: 'lines' }] },
            { var: 'Bad Key' },
            'text',
            Number.NaN,
        ]
        for (const e of bad) expect(computeExprSchema.safeParse(e).success).toBe(false)
    })
})

describe('exprRefs', () => {
    it('collects variables and aggregates', () => {
        const expr: ComputeExpr = {
            add: [
                { var: 'a' },
                { round: [{ div: [{ sumOf: [{ var: 'lines' }, 'amount'] }, { var: 'b' }] }, 0] },
            ],
        }
        expect(exprRefs(expr)).toEqual({
            vars: ['a', 'b'],
            aggregates: [{ table: 'lines', column: 'amount' }],
        })
    })

    it('reports count without a column', () => {
        expect(exprRefs({ count: [{ var: 'lines' }] }).aggregates).toEqual([{ table: 'lines' }])
    })
})

describe('roundHalfAway', () => {
    it('rounds halves away from zero', () => {
        expect(roundHalfAway(0.5, 0)).toBe(1)
        expect(roundHalfAway(-0.5, 0)).toBe(-1)
        expect(roundHalfAway(2.5, 0)).toBe(3)
        expect(roundHalfAway(-2.5, 0)).toBe(-3)
        expect(roundHalfAway(1832.6666666666667, 2)).toBe(1832.67)
    })

    it('never returns negative zero', () => {
        expect(Object.is(roundHalfAway(-0.2, 0), 0)).toBe(true)
    })
})

describe('evalCompute', () => {
    it('reads missing, null, and non-numbers as 0, true as 1', () => {
        expect(evalCompute({ var: 'x' }, {})).toBe(0)
        expect(evalCompute({ var: 'x' }, { x: null })).toBe(0)
        expect(evalCompute({ var: 'x' }, { x: 'text' })).toBe(0)
        expect(evalCompute({ var: 'x' }, { x: true })).toBe(1)
        expect(evalCompute({ var: 'x' }, { x: false })).toBe(0)
    })

    it('divides by zero as 0', () => {
        expect(evalCompute({ div: [5, 0] }, {})).toBe(0)
        expect(evalCompute({ div: [5, { var: 'missing' }] }, {})).toBe(0)
    })

    it('evaluates arithmetic left to right', () => {
        expect(evalCompute({ add: [1, 2, 3] }, {})).toBe(6)
        expect(evalCompute({ sub: [10, 4] }, {})).toBe(6)
        expect(evalCompute({ mul: [2, 3, 4] }, {})).toBe(24)
        expect(evalCompute({ min: [3, 1, 2] }, {})).toBe(1)
        expect(evalCompute({ max: [3, 1, 2] }, {})).toBe(3)
    })

    it('sums a column and counts rows, ignoring non-rows', () => {
        const scope = { lines: [{ amount: 3 }, { amount: 4 }, 'junk', null] }
        expect(evalCompute({ sumOf: [{ var: 'lines' }, 'amount'] }, scope)).toBe(7)
        expect(evalCompute({ count: [{ var: 'lines' }] }, scope)).toBe(2)
        expect(evalCompute({ sumOf: [{ var: 'nope' }, 'amount'] }, {})).toBe(0)
    })
})

describe('orderNodes', () => {
    it('puts dependencies first', () => {
        const deps = new Map([
            ['total', ['subtotal', 'tax']],
            ['tax', ['subtotal']],
            ['subtotal', []],
        ])
        const r = orderNodes(deps)
        if (!('order' in r)) throw new Error('expected an order')
        expect(r.order.indexOf('subtotal')).toBeLessThan(r.order.indexOf('tax'))
        expect(r.order.indexOf('tax')).toBeLessThan(r.order.indexOf('total'))
    })

    it('ignores dependencies that are not nodes', () => {
        const r = orderNodes(new Map([['a', ['plain_field']]]))
        expect(r).toEqual({ order: ['a'] })
    })

    it('names a cycle, including a self reference', () => {
        const two = orderNodes(
            new Map([
                ['a', ['b']],
                ['b', ['a']],
            ])
        )
        expect('cycle' in two && two.cycle).toEqual(['a', 'b', 'a'])
        const self = orderNodes(new Map([['a', ['a']]]))
        expect('cycle' in self && self.cycle).toEqual(['a', 'a'])
    })
})
