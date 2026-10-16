import { beforeEach, describe, expect, it, vi } from 'vitest'

const openAuthSessionAsync = vi.fn()
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: (...a: unknown[]) => openAuthSessionAsync(...a),
}))
vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn(async () => 'abc+/='),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { BASE64: 'base64' },
}))
vi.mock('@tinycld/core/lib/pocketbase', () => ({
    PB_SERVER_ADDR: 'https://srv.test',
    pb: { send: vi.fn() },
}))

import { openNativeAuthSheet, readCallbackQuery } from '../native-auth'
import { NativeAuthCancelled, NativeAuthPasswordChanged } from '../native-auth-errors'

describe('openNativeAuthSheet', () => {
    beforeEach(() => openAuthSessionAsync.mockReset())

    it('puts the parameters in the fragment', async () => {
        openAuthSessionAsync.mockResolvedValue({
            type: 'success',
            url: 'tinycld://auth/callback?code=c',
        })
        await expect(openNativeAuthSheet({ mode: 'login', ticket: 't' })).resolves.toEqual({
            code: 'c',
        })
        expect(openAuthSessionAsync.mock.calls[0][0]).toBe(
            'https://srv.test/a/native-auth#mode=login&ticket=t'
        )
    })

    // A temporary password replaced in the sheet: the app must tell the user
    // to sign in again, not show an error.
    it('reports a password change made in the sheet', async () => {
        openAuthSessionAsync.mockResolvedValue({
            type: 'success',
            url: 'tinycld://auth/callback?result=password_changed',
        })
        await expect(openNativeAuthSheet({ mode: 'login' })).rejects.toBeInstanceOf(
            NativeAuthPasswordChanged
        )
    })

    it('treats a dismissed sheet or "Back to the app" as a cancel', async () => {
        openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' })
        await expect(openNativeAuthSheet({ mode: 'login' })).rejects.toBeInstanceOf(
            NativeAuthCancelled
        )
        openAuthSessionAsync.mockResolvedValue({
            type: 'success',
            url: 'tinycld://auth/callback?error=cancelled',
        })
        await expect(openNativeAuthSheet({ mode: 'login' })).rejects.toBeInstanceOf(
            NativeAuthCancelled
        )
    })
})

describe('readCallbackQuery', () => {
    it('decodes the query', () => {
        expect(readCallbackQuery('tinycld://auth/callback?a=1&b=x%20y#frag')).toEqual({
            a: '1',
            b: 'x y',
        })
    })
})
