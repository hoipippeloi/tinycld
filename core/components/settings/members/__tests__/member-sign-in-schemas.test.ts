import { describe, expect, it } from 'vitest'
import { resetEmailSchema, temporaryPasswordSchema } from '../member-sign-in-schemas'

describe('temporaryPasswordSchema', () => {
    it('needs 8 characters typed twice the same', () => {
        expect(
            temporaryPasswordSchema.safeParse({ password: 'short', passwordConfirm: 'short' })
                .success
        ).toBe(false)
        expect(
            temporaryPasswordSchema.safeParse({
                password: 'Temporary1',
                passwordConfirm: 'Temporary2',
            }).success
        ).toBe(false)
        expect(
            temporaryPasswordSchema.safeParse({
                password: 'Temporary1',
                passwordConfirm: 'Temporary1',
            }).success
        ).toBe(true)
    })
})

describe('resetEmailSchema', () => {
    it('trims and validates the address', () => {
        expect(resetEmailSchema.parse({ email: '  ada@example.com ' })).toEqual({
            email: 'ada@example.com',
        })
        expect(resetEmailSchema.safeParse({ email: 'nope' }).success).toBe(false)
    })
})
