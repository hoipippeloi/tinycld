import { ClientResponseError } from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { signInStepFromError } from '../sign-in-step'

describe('signInStepFromError', () => {
    it('reads an MFA step and drops unknown methods', () => {
        const err = new ClientResponseError({
            status: 401,
            response: { mfaToken: 'tok', methods: ['passkey', 'sms'] },
        })
        expect(signInStepFromError(err)).toEqual({
            kind: 'mfa',
            token: 'tok',
            methods: ['passkey'],
        })
    })

    it('reads an enroll step', () => {
        const err = new ClientResponseError({ status: 401, response: { mfaEnrollToken: 'e' } })
        expect(signInStepFromError(err)).toEqual({ kind: 'enroll', token: 'e' })
    })

    it('reads the new-password step after a temporary password', () => {
        const err = new ClientResponseError({ status: 401, response: { passwordResetToken: 'r' } })
        expect(signInStepFromError(err)).toEqual({ kind: 'password', token: 'r' })
    })

    it('ignores other errors', () => {
        expect(signInStepFromError(new Error('x'))).toBeNull()
        expect(
            signInStepFromError(
                new ClientResponseError({ status: 400, response: { mfaToken: 't' } })
            )
        ).toBeNull()
        expect(
            signInStepFromError(new ClientResponseError({ status: 401, response: {} }))
        ).toBeNull()
    })
})
