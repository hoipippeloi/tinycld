import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'

/**
 * What a passkey does on this platform. The web runs the WebAuthn ceremony in
 * the page (passkey.web.ts). Native runs it in the system browser sheet on the
 * server's own web origin and receives the session back (passkey.ts): iOS
 * lets an app call the passkey API directly only for domains in its build-time
 * entitlements, and a self-hosted server's domain cannot be one of them.
 *
 * Both files export one object of this type, so the two cannot drift apart.
 */
export type PasskeyApi = {
    /** False only on a browser with no WebAuthn. */
    isAvailable: () => boolean
    /** Sign in with a passkey alone (no username, no password). */
    signIn: () => Promise<AuthResponse>
    /** Finish a password sign-in with a passkey as the second step. */
    secondStep: (mfaToken: string) => Promise<AuthResponse>
    /** Add a passkey to the signed-in account. */
    add: (name: string) => Promise<void>
    /** Enroll a passkey during a required enrollment; resolves to the session. */
    enroll: (enrollToken: string, name: string) => Promise<AuthResponse>
}

/** A default name for a new passkey, which the user can rename later. */
export function defaultPasskeyName(platform: string): string {
    switch (platform) {
        case 'ios':
            return 'iPhone or iPad'
        case 'android':
            return 'Android device'
        default:
            return 'Passkey'
    }
}
