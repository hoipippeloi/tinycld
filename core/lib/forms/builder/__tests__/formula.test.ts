import { describe, expect, it } from 'vitest'
import { type ComputeExpr, computeExprSchema } from '../../expression'
import {
    addOperand,
    asExpr,
    canRemoveOperand,
    describeFormula,
    exprAt,
    type FormulaOperands,
    partsFor,
    removeOperand,
    replaceAt,
    setAggregateColumn,
    setAggregateTable,
    setPlaces,
    withPart,
} from '../formula'

const operands: FormulaOperands = {
    values: [
        { key: 'qty', label: 'Qty' },
        { key: 'rate', label: 'Rate' },
    ],
    tables: [
        { key: 'notes_list', label: 'Notes', columns: [] },
        {
            key: 'parts',
            label: 'Parts',
            columns: [
                { key: 'qty', label: 'Qty' },
                { key: 'total', label: 'Total' },
            ],
        },
        { key: 'jobs', label: 'Jobs', columns: [{ key: 'hours', label: 'Hours' }] },
    ],
}
const none: FormulaOperands = { values: [], tables: [] }

describe('asExpr', () => {
    it('reads a stored formula, and anything else as 0', () => {
        expect(asExpr({ mul: [{ var: 'qty' }, 2] })).toEqual({ mul: [{ var: 'qty' }, 2] })
        expect(asExpr(undefined)).toBe(0)
        expect(asExpr('qty * 2')).toBe(0)
        expect(asExpr({ add: [1] })).toBe(0)
    })
})

describe('paths', () => {
    const tree: ComputeExpr = {
        mul: [{ add: [{ var: 'qty' }, 1] }, { round: [{ var: 'rate' }, 2] }],
    }

    it('finds a part through the operands and through what Round rounds', () => {
        expect(exprAt(tree, [])).toBe(tree)
        expect(exprAt(tree, [0, 1])).toBe(1)
        expect(exprAt(tree, [1, 0])).toEqual({ var: 'rate' })
        expect(exprAt(tree, [2])).toBeUndefined()
    })

    it('replaces one part and keeps the rest', () => {
        expect(replaceAt(tree, [0, 1], 5)).toEqual({
            mul: [{ add: [{ var: 'qty' }, 5] }, { round: [{ var: 'rate' }, 2] }],
        })
        expect(replaceAt(tree, [1, 0], 3)).toEqual({
            mul: [{ add: [{ var: 'qty' }, 1] }, { round: [3, 2] }],
        })
        expect(replaceAt(tree, [], 7)).toBe(7)
        expect(replaceAt(tree, [4], 7)).toBe(tree)
    })
})

describe('withPart', () => {
    it("carries an operator's parts to another operator", () => {
        expect(withPart({ add: [1, 2, 3] }, 'mul', operands)).toEqual({ mul: [1, 2, 3] })
        expect(withPart({ add: [1, 2, 3] }, 'sub', operands)).toEqual({ sub: [1, 2] })
        expect(withPart({ div: [4, 2] }, 'max', operands)).toEqual({ max: [4, 2] })
    })

    it('makes any other part the first part, padded with 0', () => {
        expect(withPart({ var: 'qty' }, 'mul', operands)).toEqual({ mul: [{ var: 'qty' }, 0] })
        expect(withPart(5, 'div', operands)).toEqual({ div: [5, 0] })
    })

    it('wraps the part in Round at 2 places', () => {
        expect(withPart({ var: 'qty' }, 'round', operands)).toEqual({ round: [{ var: 'qty' }, 2] })
    })

    it('starts a Field on the first value and a Number at 0', () => {
        expect(withPart(3, 'field', operands)).toEqual({ var: 'qty' })
        expect(withPart({ var: 'qty' }, 'number', operands)).toBe(0)
    })

    it('starts a total on the first table it can read, and keeps the table between totals', () => {
        expect(withPart(0, 'sumOf', operands)).toEqual({ sumOf: [{ var: 'parts' }, 'qty'] })
        expect(withPart(0, 'count', operands)).toEqual({ count: [{ var: 'notes_list' }] })
        expect(withPart({ sumOf: [{ var: 'jobs' }, 'hours'] }, 'count', operands)).toEqual({
            count: [{ var: 'jobs' }],
        })
        expect(withPart({ count: [{ var: 'notes_list' }] }, 'sumOf', operands)).toEqual({
            sumOf: [{ var: 'parts' }, 'qty'],
        })
    })

    it('changes nothing for the same part or for a part with nothing to read', () => {
        const same: ComputeExpr = { add: [1, 2] }
        expect(withPart(same, 'add', operands)).toBe(same)
        expect(withPart(3, 'field', none)).toBe(3)
        expect(withPart(3, 'sumOf', none)).toBe(3)
    })

    it('never makes a formula the schema refuses', () => {
        const starts: ComputeExpr[] = [
            0,
            4,
            { var: 'qty' },
            { add: [1, 2, 3] },
            { sub: [1, 2] },
            { round: [{ var: 'rate' }, 1] },
            { min: [1] },
            { sumOf: [{ var: 'parts' }, 'total'] },
            { count: [{ var: 'parts' }] },
        ]
        for (const start of starts)
            for (const part of partsFor(operands))
                expect(computeExprSchema.safeParse(withPart(start, part, operands)).success).toBe(
                    true
                )
    })
})

describe('operand edits', () => {
    it('adds a 0 part to Add, Multiply, Smallest of and Largest of only', () => {
        expect(addOperand({ add: [1, 2] })).toEqual({ add: [1, 2, 0] })
        expect(addOperand({ max: [1, 2] })).toEqual({ max: [1, 2, 0] })
        const sub: ComputeExpr = { sub: [1, 2] }
        expect(addOperand(sub)).toBe(sub)
    })

    it('removes a part but keeps two', () => {
        expect(removeOperand({ mul: [1, 2, 3] }, 0)).toEqual({ mul: [2, 3] })
        const two: ComputeExpr = { mul: [1, 2] }
        expect(canRemoveOperand(two)).toBe(false)
        expect(removeOperand(two, 0)).toBe(two)
    })

    it("sets Round's places, a total's table and its column", () => {
        expect(setPlaces({ round: [{ var: 'qty' }, 2] }, 0)).toEqual({ round: [{ var: 'qty' }, 0] })
        expect(setAggregateColumn({ sumOf: [{ var: 'parts' }, 'qty'] }, 'total')).toEqual({
            sumOf: [{ var: 'parts' }, 'total'],
        })
        expect(setAggregateTable({ count: [{ var: 'parts' }] }, 'jobs', operands)).toEqual({
            count: [{ var: 'jobs' }],
        })
        expect(setAggregateTable({ sumOf: [{ var: 'parts' }, 'total'] }, 'jobs', operands)).toEqual(
            {
                sumOf: [{ var: 'jobs' }, 'hours'],
            }
        )
    })
})

describe('partsFor', () => {
    it('offers Field only with values, and the totals only with tables', () => {
        const always = ['number', 'add', 'sub', 'mul', 'div', 'round', 'min', 'max']
        expect(partsFor(operands)).toEqual([
            'number',
            'field',
            'add',
            'sub',
            'mul',
            'div',
            'round',
            'min',
            'max',
            'sumOf',
            'count',
        ])
        expect(partsFor(none)).toEqual(always)
        expect(
            partsFor({ values: [], tables: [{ key: 'notes_list', label: 'Notes', columns: [] }] })
        ).toEqual([...always, 'count'])
    })
})

describe('describeFormula', () => {
    it('reads a formula as text, with brackets only around a nested infix part', () => {
        expect(describeFormula({ mul: [{ var: 'qty' }, { var: 'rate' }] }, operands)).toBe(
            'Qty × Rate'
        )
        expect(describeFormula({ mul: [{ add: [{ var: 'qty' }, 1] }, 2] }, operands)).toBe(
            '(Qty + 1) × 2'
        )
        expect(describeFormula({ sub: [10, { div: [{ var: 'qty' }, 4] }] }, operands)).toBe(
            '10 − (Qty ÷ 4)'
        )
        expect(describeFormula({ round: [{ add: [1, 2] }, 2] }, operands)).toBe('round(1 + 2, 2)')
        expect(describeFormula({ min: [{ var: 'qty' }, 5] }, operands)).toBe('smallest of (Qty, 5)')
        expect(describeFormula({ max: [1, 2] }, operands)).toBe('largest of (1, 2)')
        expect(describeFormula({ sumOf: [{ var: 'parts' }, 'total'] }, operands)).toBe(
            'sum of Total in Parts'
        )
        expect(describeFormula({ count: [{ var: 'parts' }] }, operands)).toBe('rows in Parts')
    })

    it('names what a formula reads that is gone', () => {
        expect(describeFormula({ add: [{ var: 'gone' }, 1] }, operands)).toBe('gone (missing) + 1')
        expect(describeFormula({ sumOf: [{ var: 'parts' }, 'cost'] }, operands)).toBe(
            'sum of cost (missing) in Parts'
        )
    })
})
