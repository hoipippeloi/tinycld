import { describe, expect, it } from 'vitest'
import { deviceAuthorizeSchema, lookupUserCode } from '../device-authorize-schema'

describe('lookupUserCode', () => {
    it('holds the lookup until a full code is typed', () => {
        expect(lookupUserCode('')).toBeNull()
        expect(lookupUserCode('WDJB-MJH')).toBeNull()
        expect(lookupUserCode('  WDJB-MJH  ')).toBeNull()
    })

    it('returns the trimmed, upper-case code once it is long enough', () => {
        expect(lookupUserCode('WDJB-MJHT')).toBe('WDJB-MJHT')
        expect(lookupUserCode(' wdjb-mjht ')).toBe('WDJB-MJHT')
    })
})

describe('deviceAuthorizeSchema', () => {
    it('allows a blank device label, trimmed', () => {
        expect(deviceAuthorizeSchema.parse({ code: 'WDJB-MJHT', deviceLabel: '   ' })).toEqual({
            code: 'WDJB-MJHT',
            deviceLabel: '',
        })
    })

    it('rejects a device label longer than the server stores', () => {
        const deviceLabel = 'x'.repeat(201)
        expect(deviceAuthorizeSchema.safeParse({ code: 'WDJB-MJHT', deviceLabel }).success).toBe(
            false
        )
    })
})
