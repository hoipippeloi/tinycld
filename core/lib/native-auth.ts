import { NativeAuthCancelled } from '@tinycld/core/lib/native-auth-errors'
import { PB_SERVER_ADDR, pb } from '@tinycld/core/lib/pocketbase'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'

/** Where the browser sheet sends the user back. Must match the server page. */
export const NATIVE_AUTH_CALLBACK = 'tinycld://auth/callback'

export function toBase64Url(base64: string): string {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return toBase64Url(btoa(binary))
}

async function challengeFor(verifier: string): Promise<string> {
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
    })
    return toBase64Url(digest)
}

type SheetParams = Record<string, string>

/**
 * Reads the query of the callback URL. Parsed by hand: React Native's URL
 * implementation does not support reading search params on every version.
 */
export function readCallbackQuery(url: string): Record<string, string> {
    const query = url.split('?')[1]?.split('#')[0] ?? ''
    const out: Record<string, string> = {}
    for (const pair of query.split('&')) {
        if (!pair) continue
        const [key, value = ''] = pair.split('=')
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '))
    }
    return out
}

/**
 * Opens the server's /a/native-auth page in the system browser sheet and
 * waits for it to send the user back. Resolves to the query of the callback
 * URL. A dismissed sheet, or the page's "Back to the app" link, rejects with
 * NativeAuthCancelled.
 */
export async function openNativeAuthSheet(params: SheetParams): Promise<Record<string, string>> {
    // In the fragment, not the query: the browser never sends a fragment to
    // a server, so the ticket or enroll token stays out of access logs.
    const fragment = new URLSearchParams(params).toString()
    const result = await WebBrowser.openAuthSessionAsync(
        `${PB_SERVER_ADDR}/a/native-auth#${fragment}`,
        NATIVE_AUTH_CALLBACK
    )
    if (result.type !== 'success') throw new NativeAuthCancelled()
    const returned = readCallbackQuery(result.url)
    if (returned.error) throw new NativeAuthCancelled()
    return returned
}

/**
 * Runs a browser-sheet sign-in that ends with a session, and exchanges the
 * one-time code it returns. The verifier never leaves the app, so a code that
 * another app intercepts on the tinycld:// scheme is useless to it.
 */
export async function signInThroughSheet(params: SheetParams): Promise<AuthResponse> {
    const verifier = randomVerifier()
    const returned = await openNativeAuthSheet({
        ...params,
        code_challenge: await challengeFor(verifier),
    })
    const code = returned.code
    if (!code) throw new Error('The sign-in page did not return a code.')
    return pb.send<AuthResponse>('/api/auth/native/exchange', {
        method: 'POST',
        body: { code, codeVerifier: verifier },
    })
}
