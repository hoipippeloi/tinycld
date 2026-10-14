import {
    browserSupportsWebAuthn,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    startAuthentication,
    startRegistration,
} from '@simplewebauthn/browser'
import type { PasskeyApi } from '@tinycld/core/lib/passkey-types'
import { pb } from '@tinycld/core/lib/pocketbase'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'

type Begin<T> = { options: T; sessionToken: string }

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return pb.send<T>(path, { method: 'POST', body })
}

async function runSignIn(beginPath: string, finishPath: string, extra: Record<string, unknown>) {
    const begin = await post<Begin<PublicKeyCredentialRequestOptionsJSON>>(beginPath, extra)
    const credential = await startAuthentication({ optionsJSON: begin.options })
    return post<AuthResponse>(finishPath, {
        ...extra,
        sessionToken: begin.sessionToken,
        credential,
    })
}

/**
 * Register a passkey. `auth` names who is registering when there is no
 * session: an enroll token during a required enrollment, or the ticket the
 * native app passes to the browser sheet.
 */
export async function registerPasskey<T>(name: string, auth: Record<string, string>): Promise<T> {
    const begin = await post<Begin<PublicKeyCredentialCreationOptionsJSON>>(
        '/api/account/passkeys/register/begin',
        auth
    )
    const credential = await startRegistration({ optionsJSON: begin.options })
    return post<T>('/api/account/passkeys/register/finish', {
        ...auth,
        name,
        sessionToken: begin.sessionToken,
        credential,
    })
}

export const passkeys: PasskeyApi = {
    isAvailable: () => browserSupportsWebAuthn(),
    signIn: () => runSignIn('/api/auth/passkey/login/begin', '/api/auth/passkey/login/finish', {}),
    secondStep: mfaToken =>
        runSignIn('/api/auth/mfa/passkey/begin', '/api/auth/mfa/passkey/finish', { mfaToken }),
    add: async name => {
        await registerPasskey(name, {})
    },
    enroll: (enrollToken, name) =>
        registerPasskey<AuthResponse>(name, { mfaEnrollToken: enrollToken }),
}
