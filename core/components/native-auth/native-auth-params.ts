// The /a/native-auth page's parameters, as the native app builds them (see
// core/lib/native-auth.ts). They arrive in the URL fragment, which the browser
// never sends to the server. Parsed in one place so the page and its tests
// agree on what a usable request is.

export type NativeAuthRequest =
    | { mode: 'login'; codeChallenge: string }
    | { mode: 'enroll'; codeChallenge: string; enrollToken: string; name: string }
    | { mode: 'register'; ticket: string; name: string }

type RawParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

// An S256 challenge is 32 bytes, base64url without padding.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

export function parseNativeAuthRequest(params: RawParams): NativeAuthRequest | null {
    const mode = first(params.mode)
    const codeChallenge = first(params.code_challenge)
    const name = first(params.name) || 'Passkey'
    if (mode === 'login' && CHALLENGE.test(codeChallenge)) {
        return { mode, codeChallenge }
    }
    if (mode === 'enroll' && CHALLENGE.test(codeChallenge) && first(params.enroll_token)) {
        return { mode, codeChallenge, enrollToken: first(params.enroll_token), name }
    }
    if (mode === 'register' && first(params.ticket)) {
        return { mode, ticket: first(params.ticket), name }
    }
    return null
}

export const NATIVE_CALLBACK = 'tinycld://auth/callback'

export function callbackUrl(params: Record<string, string>): string {
    return `${NATIVE_CALLBACK}?${new URLSearchParams(params).toString()}`
}

/** The parameters in a URL fragment such as `#mode=login&code_challenge=…`. */
export function fragmentParams(hash: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(hash.replace(/^#/, '')))
}
