import { describe, expect, it } from 'vitest'
import { definitionSchema } from '../definition'
import { bugDefinition } from './fixtures'

describe('definitionSchema', () => {
    it('accepts a valid definition and fills defaults', () => {
        const parsed = definitionSchema.parse({
            version: 1,
            pages: [{ key: 'p', title: 'P' }],
            fields: [],
        })
        expect(parsed.rules).toEqual([])
        expect(parsed.defaults).toEqual({})
        expect(parsed.submit.required).toEqual([])
    })
    it('accepts the bug definition', () => {
        expect(definitionSchema.safeParse(bugDefinition).success).toBe(true)
    })
    it('rejects a duplicate field key', () => {
        const r = definitionSchema.safeParse({
            ...bugDefinition,
            fields: [...bugDefinition.fields, { ...bugDefinition.fields[1] }],
        })
        expect(r.success).toBe(false)
        expect(JSON.stringify(r.error?.issues)).toContain('duplicate')
    })
    it('rejects a key that is not a slug', () => {
        const bad = { ...bugDefinition.fields[1], key: 'Bad Key' }
        expect(
            definitionSchema.safeParse({ ...bugDefinition, fields: [bugDefinition.fields[0], bad] })
                .success
        ).toBe(false)
    })
    it('rejects a field on a page that does not exist', () => {
        const bad = { ...bugDefinition.fields[1], page: 'nope' }
        expect(
            definitionSchema.safeParse({ ...bugDefinition, fields: [bugDefinition.fields[0], bad] })
                .success
        ).toBe(false)
    })
    it('rejects a rule that names a missing field', () => {
        const rules = [
            { ...bugDefinition.rules[0], when: [{ field: 'ghost', op: 'is', value: 'x' }] },
        ]
        expect(definitionSchema.safeParse({ ...bugDefinition, rules }).success).toBe(false)
    })
    it('rejects a rule action that names a missing page', () => {
        const rules = [{ ...bugDefinition.rules[0], actions: [{ action: 'show', page: 'ghost' }] }]
        expect(definitionSchema.safeParse({ ...bugDefinition, rules }).success).toBe(false)
    })
    it('rejects an operator the field kind does not support', () => {
        const rules = [
            { ...bugDefinition.rules[0], when: [{ field: 'severity', op: 'gt', value: 1 }] },
        ]
        expect(definitionSchema.safeParse({ ...bugDefinition, rules }).success).toBe(false)
    })
    it('rejects a require action on a page', () => {
        const rules = [
            { ...bugDefinition.rules[0], actions: [{ action: 'require', page: 'repro' }] },
        ]
        expect(definitionSchema.safeParse({ ...bugDefinition, rules }).success).toBe(false)
    })
    it('rejects a default for a missing field', () => {
        expect(
            definitionSchema.safeParse({ ...bugDefinition, defaults: { ghost: 1 } }).success
        ).toBe(false)
    })
    it('rejects an empty pages list', () => {
        expect(definitionSchema.safeParse({ ...bugDefinition, pages: [] }).success).toBe(false)
    })
})
