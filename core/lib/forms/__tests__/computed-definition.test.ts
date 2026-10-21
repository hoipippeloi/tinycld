import { describe, expect, it } from 'vitest'
import { definitionSchema } from '../definition'
import fixture from '../fixtures/computed-fixture.json'

function defWith(fields: Record<string, unknown>[]) {
    return {
        version: 1,
        pages: [{ key: 'main', title: 'Main' }],
        fields: fields.map(f => ({
            page: 'main',
            width: 'full',
            required: false,
            hidden: false,
            ...f,
        })),
    }
}
const number = (key: string) => ({ key, kind: 'number', label: key })
const computed = (key: string, expression: unknown) => ({
    key,
    kind: 'computed',
    label: key,
    expression,
})
const table = (key: string, columns: unknown[]) => ({ key, kind: 'table', label: key, columns })
const col = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
    key,
    kind,
    label: key,
    ...extra,
})

function issues(def: unknown): string {
    const r = definitionSchema.safeParse(def)
    return r.success ? '' : JSON.stringify(r.error.issues)
}

describe('computed and table fields', () => {
    it('accepts the shared fixture definition', () => {
        expect(definitionSchema.safeParse(fixture.definition).success).toBe(true)
    })

    it('fills decimals with 0', () => {
        const parsed = definitionSchema.parse(defWith([number('a'), computed('b', { var: 'a' })]))
        const b = parsed.fields.find(f => f.key === 'b')
        expect(b && 'decimals' in b && b.decimals).toBe(0)
    })

    it('rejects a formula that reads an unknown field', () => {
        expect(issues(defWith([computed('b', { var: 'ghost' })]))).toContain('unknown field ghost')
    })

    it('rejects a formula that reads a text field', () => {
        const text = { key: 't', kind: 'text', label: 't' }
        expect(issues(defWith([text, computed('b', { var: 't' })]))).toContain(
            'cannot be used in a formula'
        )
    })

    it('rejects two formulas that depend on each other, naming the cycle', () => {
        const msg = issues(defWith([computed('a', { var: 'b' }), computed('b', { var: 'a' })]))
        expect(msg).toContain('formula cycle')
        expect(msg).toContain('a')
    })

    it('rejects a formula that reads itself', () => {
        expect(issues(defWith([computed('a', { add: [{ var: 'a' }, 1] })]))).toContain(
            'formula cycle'
        )
    })

    it('rejects sumOf over a field that is not a table', () => {
        const msg = issues(defWith([number('n'), computed('s', { sumOf: [{ var: 'n' }, 'x'] })]))
        expect(msg).toContain('is not a table')
    })

    it('rejects sumOf over an unknown or non-numeric column', () => {
        const lines = table('lines', [col('qty', 'number'), col('note', 'text')])
        expect(
            issues(defWith([lines, computed('s', { sumOf: [{ var: 'lines' }, 'nope'] })]))
        ).toContain('unknown column nope')
        expect(
            issues(defWith([lines, computed('s', { sumOf: [{ var: 'lines' }, 'note'] })]))
        ).toContain('is not numeric')
    })

    it('accepts count over a table', () => {
        const lines = table('lines', [col('qty', 'number')])
        expect(issues(defWith([lines, computed('c', { count: [{ var: 'lines' }] })]))).toBe('')
    })

    it('rejects a column formula that sums a table', () => {
        const lines = table('lines', [
            col('qty', 'number'),
            col('x', 'computed', { expression: { sumOf: [{ var: 'lines' }, 'qty'] } }),
        ])
        expect(issues(defWith([lines]))).toContain('cannot sum or count')
    })

    it('rejects a column formula that reads a column that is not a sibling or not numeric', () => {
        const a = table('lines', [
            col('note', 'text'),
            col('x', 'computed', { expression: { var: 'note' } }),
        ])
        expect(issues(defWith([a]))).toContain('cannot be used in a formula')
        const b = table('lines', [col('x', 'computed', { expression: { var: 'other_field' } })])
        expect(issues(defWith([b]))).toContain('unknown column other_field')
    })

    it('rejects a column cycle, a duplicate column key, and a column named id', () => {
        const cyc = table('lines', [
            col('a', 'computed', { expression: { var: 'b' } }),
            col('b', 'computed', { expression: { var: 'a' } }),
        ])
        expect(issues(defWith([cyc]))).toContain('formula cycle')
        const dup = table('lines', [col('a', 'number'), col('a', 'number')])
        expect(issues(defWith([dup]))).toContain('duplicate column key a')
        const id = table('lines', [col('id', 'number')])
        expect(issues(defWith([id]))).toContain('id is reserved')
    })

    it('rejects a table with no columns', () => {
        expect(definitionSchema.safeParse(defWith([table('lines', [])])).success).toBe(false)
    })
})
