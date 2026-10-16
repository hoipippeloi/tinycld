import { describe, expect, it } from 'vitest'
import { callbackUrl, fragmentParams, parseNativeAuthRequest } from '../native-auth-params'

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('parseNativeAuthRequest', () => {
    it('accepts a login with an S256 challenge', () => {
        expect(parseNativeAuthRequest({ mode: 'login', code_challenge: CHALLENGE })).toEqual({
            mode: 'login',
            codeChallenge: CHALLENGE,
        })
    })

    it('refuses a login without a well-formed challenge', () => {
        expect(parseNativeAuthRequest({ mode: 'login' })).toBeNull()
        expect(parseNativeAuthRequest({ mode: 'login', code_challenge: 'short' })).toBeNull()
    })

    it('needs an enroll token for enroll and a ticket for register', () => {
        expect(parseNativeAuthRequest({ mode: 'enroll', code_challenge: CHALLENGE })).toBeNull()
        expect(parseNativeAuthRequest({ mode: 'register' })).toBeNull()
        expect(
            parseNativeAuthRequest({
                mode: 'enroll',
                code_challenge: CHALLENGE,
                enroll_token: 'e',
                name: 'Phone',
            })
        ).toEqual({ mode: 'enroll', codeChallenge: CHALLENGE, enrollToken: 'e', name: 'Phone' })
        expect(parseNativeAuthRequest({ mode: 'register', ticket: 't' })).toEqual({
            mode: 'register',
            ticket: 't',
            name: 'Passkey',
        })
    })

    it('refuses an unknown mode', () => {
        expect(parseNativeAuthRequest({ mode: 'steal', code_challenge: CHALLENGE })).toBeNull()
    })

    it('reads the first value of a repeated parameter', () => {
        expect(
            parseNativeAuthRequest({ mode: ['login', 'register'], code_challenge: CHALLENGE })?.mode
        ).toBe('login')
    })
})

describe('callbackUrl', () => {
    it('always targets the app callback', () => {
        expect(callbackUrl({ code: 'a b' })).toBe('tinycld://auth/callback?code=a+b')
    })
})

describe('fragmentParams', () => {
    it('reads the parameters after the hash', () => {
        expect(fragmentParams('#mode=register&ticket=a.b.c&name=My+phone')).toEqual({
            mode: 'register',
            ticket: 'a.b.c',
            name: 'My phone',
        })
        expect(fragmentParams('')).toEqual({})
    })
})
