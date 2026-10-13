import { describe, expect, it } from 'vitest'
import { labelSchema } from '../../components/label-schema'

describe('labelSchema', () => {
    it('trims the name it saves', () => {
        const result = labelSchema.safeParse({ name: '  Urgent ', color: '#4A86E8' })
        expect(result.data).toEqual({ name: 'Urgent', color: '#4A86E8' })
    })

    it('rejects a whitespace-only name', () => {
        const result = labelSchema.safeParse({ name: '   ', color: '#4A86E8' })
        expect(result.error?.issues[0]?.message).toBe('Name is required')
    })

    it('rejects a name over 50 characters', () => {
        const result = labelSchema.safeParse({ name: 'x'.repeat(51), color: '#4A86E8' })
        expect(result.error?.issues[0]?.message).toBe('Name must be 50 characters or fewer')
    })

    it('requires a color', () => {
        const result = labelSchema.safeParse({ name: 'Urgent', color: '' })
        expect(result.error?.issues[0]?.message).toBe('Pick a color')
    })
})
