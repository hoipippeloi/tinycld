import { describe, expect, it } from 'vitest'
import { inviteLinkSendSchema } from '../invite-link-send-schema'

describe('inviteLinkSendSchema', () => {
    it('trims a valid address', () => {
        expect(inviteLinkSendSchema.parse({ email: '  bob@example.com ' })).toEqual({
            email: 'bob@example.com',
        })
    })

    it('rejects a blank or malformed address', () => {
        expect(inviteLinkSendSchema.safeParse({ email: '   ' }).success).toBe(false)
        expect(inviteLinkSendSchema.safeParse({ email: 'bob' }).success).toBe(false)
        expect(inviteLinkSendSchema.safeParse({ email: 'bob@' }).success).toBe(false)
    })
})
