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
 * Reads the second-step 401 the server sends instead of a session when the
 * account has MFA (`mfaToken`) or must enroll (`mfaEnrollToken`). Any other
 * error returns null and stays an ordinary sign-in failure.
 */
export function signInStepFromError(error: unknown): SignInStep | null {
    if (!(error instanceof ClientResponseError) || error.status !== 401) return null
    const body = error.response as {
        mfaToken?: unknown
        mfaEnrollToken?: unknown
        methods?: unknown
    }
    if (typeof body.mfaToken === 'string' && body.mfaToken) {
        const methods = Array.isArray(body.methods) ? body.methods.filter(isMfaMethod) : []
        return { kind: 'mfa', token: body.mfaToken, methods }
    }
    if (typeof body.mfaEnrollToken === 'string' && body.mfaEnrollToken) {
        return { kind: 'enroll', token: body.mfaEnrollToken }
    }
    return null
}
