import { describe, expect, it } from 'vitest'
import { definitionSchema, type FormDefinition } from '../definition'
import fixture from '../fixtures/rules-fixture.json'
import {
    applyDefaults,
    compileCondition,
    evaluate,
    evaluateExpression,
    type FormState,
} from '../logic'

const def: FormDefinition = definitionSchema.parse(fixture.definition)
const ctx = fixture.context

function pick(state: FormState, expect_: Record<string, unknown>) {
    const out: Record<string, unknown> = {}
    const e = expect_ as {
        fields?: Record<string, unknown>
        pages?: Record<string, unknown>
        activeRules?: string[]
        setValues?: unknown
    }
    if (e.fields)
        out.fields = Object.fromEntries(Object.keys(e.fields).map(k => [k, state.fields[k]]))
    if (e.pages) out.pages = Object.fromEntries(Object.keys(e.pages).map(k => [k, state.pages[k]]))
    if (e.activeRules) out.activeRules = state.activeRules
    if (e.setValues) out.setValues = state.setValues
    return out
}

describe('evaluate against the shared fixture', () => {
    for (const c of fixture.cases) {
        it(c.name, () => {
            const state = evaluate(def, c.values, ctx)
            expect(pick(state, c.expect)).toEqual(c.expect)
        })
    }
})

describe('applyDefaults', () => {
    it('matches the fixture', () => {
        expect(applyDefaults(def, ctx)).toEqual(fixture.defaults)
    })
    it('addDays rolls the month by calendar date', () => {
        expect(
            evaluateExpression(
                { addDays: [{ today: [] }, 1] },
                { today: '2026-02-28', userId: 'u' }
            )
        ).toBe('2026-03-01')
    })
    it('me returns the user id', () => {
        expect(evaluateExpression({ me: [] }, ctx)).toBe('user_me')
    })
})

describe('compileCondition', () => {
    it('compiles is to ==', () => {
        expect(compileCondition({ field: 'kind', op: 'is', value: 'bug' })).toEqual({
            '==': [{ var: 'kind' }, 'bug'],
        })
    })
    it('compiles is_any_of to in', () => {
        expect(compileCondition({ field: 'kind', op: 'is_any_of', value: ['a', 'b'] })).toEqual({
            in: [{ var: 'kind' }, ['a', 'b']],
        })
    })
    it('compiles is_empty with the custom op', () => {
        expect(compileCondition({ field: 'kind', op: 'is_empty' })).toEqual({
            isEmpty: [{ var: 'kind' }],
        })
    })
})
