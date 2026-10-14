import { pb } from '@tinycld/core/lib/pocketbase'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'
import type { AppPasswords, MfaTotp } from '@tinycld/core/types/pbSchema'

// The second-factor and app-password routes. Every write here goes through
// a server route, not a pbtsdb insert: the server must check a code first, or
// generate a secret that is shown once and never stored in the clear. The
// caller files the returned row with acceptServerRow so live queries see it.

export type MfaProof = { code: string } | { recoveryCode: string }

/** Finish a password sign-in with an authenticator code or a recovery code. */
export function verifyMfa(mfaToken: string, proof: MfaProof): Promise<AuthResponse> {
    return pb.send<AuthResponse>('/api/auth/mfa/verify', {
        method: 'POST',
        body: { mfaToken, ...proof },
    })
}

export type TotpSetup = { record: MfaTotp; secret: string; uri: string }

/**
 * Start authenticator setup. With an enroll token (MFA is required and the
 * account has no factor yet) this runs during sign-in, before any session.
 */
export function beginTotpSetup(enrollToken?: string): Promise<TotpSetup> {
    return pb.send<TotpSetup>('/api/account/mfa/totp/begin', {
        method: 'POST',
        body: enrollToken ? { mfaEnrollToken: enrollToken } : {},
    })
}

export function confirmTotpSetup(
    code: string
): Promise<{ record: MfaTotp; recoveryCodes: string[] }> {
    return pb.send('/api/account/mfa/totp/confirm', { method: 'POST', body: { code } })
}

/** Confirm setup during a required enrollment; the response is the new session. */
export function confirmTotpEnrollment(enrollToken: string, code: string): Promise<AuthResponse> {
    return pb.send<AuthResponse>('/api/account/mfa/totp/confirm', {
        method: 'POST',
        body: { code, mfaEnrollToken: enrollToken },
    })
}

export function disableTotp(proof: MfaProof): Promise<{ id: string }> {
    return pb.send('/api/account/mfa/totp/disable', { method: 'POST', body: proof })
}

export function regenerateRecoveryCodes(
    code: string
): Promise<{ record: MfaTotp; recoveryCodes: string[] }> {
    return pb.send('/api/account/mfa/recovery/regenerate', { method: 'POST', body: { code } })
}

export function createAppPassword(
    name: string
): Promise<{ record: AppPasswords; password: string }> {
    return pb.send('/api/account/app-passwords', { method: 'POST', body: { name } })
}

/**
 * Owner/admin: email a password-reset link for another member, to their own
 * address or (when given) another one the admin confirmed with them. An
 * action that sends mail, so it is a route rather than a collection write.
 */
export function sendPasswordResetFor(userId: string, email?: string): Promise<{ sentTo: string }> {
    return pb.send(`/api/admin/users/${userId}/password-reset/send`, {
        method: 'POST',
        body: { email: email ?? '' },
    })
}
