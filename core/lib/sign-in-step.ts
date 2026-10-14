import type { Users } from '@tinycld/core/types/pbSchema'
import { ClientResponseError } from 'pocketbase'

export type MfaMethod = 'totp' | 'recovery' | 'passkey'

/**
 * A sign-in that passed the password but needs one more step before the server
 * issues a session. The token is not a session: it only lets the holder finish
 * this step, and it expires in minutes.
 */
export type SignInStep =
    | { kind: 'mfa'; token: string; methods: MfaMethod[] }
    | { kind: 'enroll'; token: string }
    // An owner or admin set a temporary password: choose a new one. The token
    // is a PocketBase password-reset token for confirmPasswordReset.
    | { kind: 'password'; token: string }

/** The body of every PocketBase auth response, and of the routes that end in one. */
export type AuthResponse = {
    token: string
    record: Users
    meta?: { recoveryCodes?: string[] }
}

const KNOWN_METHODS: readonly MfaMethod[] = ['totp', 'recovery', 'passkey']

function isMfaMethod(value: unknown): value is MfaMethod {
    return KNOWN_METHODS.includes(value as MfaMethod)
}

/**
 * Reads the 401 the server sends instead of a session when the account has
 * MFA (`mfaToken`), must enroll (`mfaEnrollToken`), or must replace an
 * admin-set temporary password (`passwordResetToken`). Any other error
 * returns null and stays an ordinary sign-in failure.
 */
export function signInStepFromError(error: unknown): SignInStep | null {
    if (!(error instanceof ClientResponseError) || error.status !== 401) return null
    const body = error.response as {
        mfaToken?: unknown
        mfaEnrollToken?: unknown
        passwordResetToken?: unknown
        methods?: unknown
    }
    if (typeof body.mfaToken === 'string' && body.mfaToken) {
        const methods = Array.isArray(body.methods) ? body.methods.filter(isMfaMethod) : []
        return { kind: 'mfa', token: body.mfaToken, methods }
    }
    if (typeof body.mfaEnrollToken === 'string' && body.mfaEnrollToken) {
        return { kind: 'enroll', token: body.mfaEnrollToken }
    }
    if (typeof body.passwordResetToken === 'string' && body.passwordResetToken) {
        return { kind: 'password', token: body.passwordResetToken }
    }
    return null
}
