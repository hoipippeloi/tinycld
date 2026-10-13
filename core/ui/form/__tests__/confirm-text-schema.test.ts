import { describe, expect, it } from 'vitest'
import { confirmTextSchema } from '../confirm-text-schema'

describe('confirmTextSchema', () => {
    it('accepts the expected text with surrounding whitespace', () => {
        const schema = confirmTextSchema('Roadmap')
        expect(schema.safeParse({ confirm: '  Roadmap ' }).success).toBe(true)
    })

    it('rejects a case mismatch by default', () => {
        const schema = confirmTextSchema('Roadmap')
        expect(schema.safeParse({ confirm: 'roadmap' }).success).toBe(false)
    })

    it('accepts a case mismatch when ignoreCase is set', () => {
        const schema = confirmTextSchema('Ann@Example.com', { ignoreCase: true })
        expect(schema.safeParse({ confirm: 'ann@example.com' }).success).toBe(true)
    })

    it('never matches an empty expected value', () => {
        const schema = confirmTextSchema('  ')
        expect(schema.safeParse({ confirm: '' }).success).toBe(false)
    })

    it('reports the message on the confirm field', () => {
        const result = confirmTextSchema('mail').safeParse({ confirm: 'cal' })
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.path).toEqual(['confirm'])
        expect(result.error?.issues[0]?.message).toBe('Type mail to confirm')
    })
})
