import { describe, expect, it } from 'vitest'
import { recoveryCodeSchema, totpCodeSchema } from '../mfa-schemas'

describe('totpCodeSchema', () => {
    it('accepts six digits, with spaces dropped', () => {
        expect(totpCodeSchema.parse({ code: '123 456' })).toEqual({ code: '123456' })
    })

    it('refuses other lengths and letters', () => {
        expect(totpCodeSchema.safeParse({ code: '12345' }).success).toBe(false)
        expect(totpCodeSchema.safeParse({ code: '12345a' }).success).toBe(false)
    })
})

describe('recoveryCodeSchema', () => {
    it('accepts a code with or without the dash', () => {
        expect(recoveryCodeSchema.parse({ recoveryCode: 'abcde-fghij' })).toEqual({
            recoveryCode: 'abcdefghij',
        })
        expect(recoveryCodeSchema.parse({ recoveryCode: 'ABCDEFGHIJ' })).toEqual({
            recoveryCode: 'ABCDEFGHIJ',
        })
    })

    it('refuses a short code', () => {
        expect(recoveryCodeSchema.safeParse({ recoveryCode: 'abc' }).success).toBe(false)
    })
})
