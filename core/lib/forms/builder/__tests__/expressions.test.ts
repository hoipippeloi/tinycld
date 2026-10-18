import { describe, expect, it } from 'vitest'
import { coerceLiteral, expressionToPick, picksFor, pickToExpression } from '../expressions'

describe('expressions', () => {
    it('round-trips every pick', () => {
        const picks = [
            { mode: 'none' as const },
            { mode: 'literal' as const, value: 'low' },
            { mode: 'literal' as const, value: 3 },
            { mode: 'literal' as const, value: ['low', 'high'] },
            { mode: 'today' as const },
            { mode: 'today_plus' as const, days: 21 },
            { mode: 'me' as const },
        ]
        for (const pick of picks) expect(expressionToPick(pickToExpression(pick))).toEqual(pick)
    })
    it('writes the exact JSON Logic the engine accepts', () => {
        expect(pickToExpression({ mode: 'today' })).toEqual({ today: [] })
        expect(pickToExpression({ mode: 'today_plus', days: 21 })).toEqual({
            addDays: [{ today: [] }, 21],
        })
        expect(pickToExpression({ mode: 'me' })).toEqual({ me: [] })
        expect(pickToExpression({ mode: 'none' })).toBeUndefined()
    })
    it('reads an unknown expression as none', () => {
        expect(expressionToPick({ foo: [] })).toEqual({ mode: 'none' })
        expect(expressionToPick([1, 2])).toEqual({ mode: 'none' })
    })
    it('offers date picks only to date kinds and me only to user kinds', () => {
        expect(picksFor('date')).toEqual(['none', 'literal', 'today', 'today_plus'])
        expect(picksFor('user')).toEqual(['none', 'me'])
        expect(picksFor('text')).toEqual(['none', 'literal'])
        expect(picksFor('file')).toEqual(['none'])
    })
    it('coerces a literal string to the kind of its field', () => {
        expect(coerceLiteral('number', '3')).toBe(3)
        expect(coerceLiteral('number', 'abc')).toBe('abc')
        expect(coerceLiteral('toggle', 'on')).toBe(true)
        expect(coerceLiteral('text', 'low')).toBe('low')
    })
})
