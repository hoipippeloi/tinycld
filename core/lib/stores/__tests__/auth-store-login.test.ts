// @vitest-environment happy-dom
import { ClientResponseError } from 'pocketbase'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock PocketBase so login() runs without a live server. authWithPassword's
// return shape drives the authenticated-user projection under test. The process
// is one org, so login() no longer resolves an org / primaryOrgSlug and never
// rejects a user for "no org" — any valid credentials sign in.
const mockAuthStoreClear = vi.fn()
const mockAuthWithPassword = vi.fn()
const mockPreloadStores = vi.fn(() => Promise.resolve())

vi.mock('@tinycld/core/lib/pocketbase', () => ({
    PB_SERVER_ADDR: 'http://localhost:8090',
    pb: {
        authStore: {
            save: vi.fn(),
            clear: mockAuthStoreClear,
            onChange: vi.fn(() => () => {}),
            token: null as string | null,
            record: null,
        },
        collection: vi.fn(() => ({
            authWithPassword: mockAuthWithPassword,
        })),
    },
    authStoreReady: Promise.resolve(),
    getUserFromAuthStore: vi.fn(() => null),
    seedUser: vi.fn(() => Promise.resolve()),
    preloadStores: mockPreloadStores,
    resetSessionState: vi.fn(() => Promise.resolve()),
    refreshAuth: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(() => Promise.resolve(null)),
        setItem: vi.fn(() => Promise.resolve()),
        removeItem: vi.fn(() => Promise.resolve()),
    },
}))

const mockCaptureException = vi.fn()
vi.mock('@tinycld/core/lib/errors', () => ({ captureException: mockCaptureException }))

vi.mock('@tinycld/core/lib/store', () => ({
    create: () => (fn: unknown) => {
        let state = {} as Record<string, unknown>
        const set = (patch: Record<string, unknown>) => {
            state = { ...state, ...patch }
        }
        const get = () => state
        type Factory = (
            set: (patch: Record<string, unknown>) => void,
            get: () => Record<string, unknown>
        ) => Record<string, unknown>
        const methods = (fn as Factory)(set, get)
        state = { ...state, ...methods }
        const store = (selector: (s: typeof state) => unknown) => selector(state)
        store.getState = () => state
        store.setState = (patch: Record<string, unknown>) => {
            state = { ...state, ...patch }
        }
        return store
    },
    persist: <T>(fn: T) => fn,
    asyncStorage: undefined,
}))

const REGULAR_USER = {
    record: { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
}
const DEMO_USER = {
    record: { id: 'u2', name: 'Demo', email: 'demo@example.com', is_demo: true },
}

describe('auth-store login()', () => {
    let login: ReturnType<typeof import('../auth-store').useAuthStore.getState>['login']

    beforeEach(async () => {
        vi.resetModules()
        mockAuthStoreClear.mockClear()
        mockAuthWithPassword.mockReset()
        const mod = await import('../auth-store')
        login = mod.useAuthStore.getState().login
    })

    afterEach(() => vi.clearAllMocks())

    it('signs in a user and returns the authenticated user projection', async () => {
        mockAuthWithPassword.mockResolvedValue(REGULAR_USER)
        const res = await login('owner@example.com', 'pw')
        expect(res.error).toBeNull()
        expect(res.user?.id).toBe('u1')
        expect(res.user?.email).toBe('owner@example.com')
        expect(res.user?.isDemo).toBe(false)
    })

    it('flags a demo user via the is_demo record field', async () => {
        mockAuthWithPassword.mockResolvedValue(DEMO_USER)
        const res = await login('demo@example.com', 'pw')
        expect(res.error).toBeNull()
        expect(res.user?.isDemo).toBe(true)
    })

    it('returns an error and no user when credentials are rejected', async () => {
        mockAuthWithPassword.mockRejectedValue(new Error('Failed to authenticate.'))
        const res = await login('nobody@example.com', 'wrong')
        expect(res.user).toBeNull()
        expect(res.error).toBe('Failed to authenticate.')
        // login() clears the session once at the start of every attempt.
        expect(mockAuthStoreClear).toHaveBeenCalledTimes(1)
    })

    // With MFA on, the server answers a correct password with a 401 that
    // carries a step token instead of a session. That is not a failure: the
    // login overlay must show the second step, so the step reaches both the
    // caller and the step store, and no error string is shown.
    it('returns the second step when the server asks for one', async () => {
        mockAuthWithPassword.mockRejectedValue(
            new ClientResponseError({
                status: 401,
                response: { mfaToken: 'pending', methods: ['totp', 'recovery', 'bogus'] },
            })
        )
        const res = await login('owner@example.com', 'pw')
        expect(res.user).toBeNull()
        expect(res.error).toBeNull()
        expect(res.step).toEqual({ kind: 'mfa', token: 'pending', methods: ['totp', 'recovery'] })

        const { useSignInStepStore } = await import('../sign-in-step-store')
        expect(useSignInStepStore.getState().step).toEqual(res.step)
    })

    it('returns the enroll step when the organization requires MFA', async () => {
        mockAuthWithPassword.mockRejectedValue(
            new ClientResponseError({ status: 401, response: { mfaEnrollToken: 'enroll' } })
        )
        const res = await login('owner@example.com', 'pw')
        expect(res.error).toBeNull()
        expect(res.step).toEqual({ kind: 'enroll', token: 'enroll' })
    })

    it('keeps an ordinary 401 an error', async () => {
        mockAuthWithPassword.mockRejectedValue(
            new ClientResponseError({
                status: 401,
                response: { message: 'Failed to authenticate.' },
            })
        )
        const res = await login('owner@example.com', 'wrong')
        expect(res.step).toBeUndefined()
        expect(res.error).toBe('Failed to authenticate.')
    })

    it('adopts a session from a second-step route and clears the step', async () => {
        const mod = await import('../auth-store')
        const { useSignInStepStore } = await import('../sign-in-step-store')
        useSignInStepStore.getState().setStep({ kind: 'mfa', token: 't', methods: ['totp'] })

        const res = await mod.useAuthStore
            .getState()
            .adoptAuthResponse({ token: 'session', record: REGULAR_USER.record as never })
        expect(res.user?.id).toBe('u1')
        expect(useSignInStepStore.getState().step).toBeNull()
    })

    // The gate opens as soon as the user is set, and the caller navigates to
    // the post-sign-in route when login() resolves. If login() also waited
    // for the store warm-up, that navigation would land after the user had
    // already moved on in the open app, and pull them back.
    it('resolves without waiting for the store warm-up', async () => {
        mockAuthWithPassword.mockResolvedValue(REGULAR_USER)
        mockPreloadStores.mockReturnValueOnce(new Promise(() => {}))
        const res = await login('owner@example.com', 'pw')
        expect(res.user?.id).toBe('u1')
        expect(mockPreloadStores).toHaveBeenCalledTimes(1)
    })

    it('reports a failed warm-up without failing the sign-in', async () => {
        mockAuthWithPassword.mockResolvedValue(REGULAR_USER)
        const failure = new Error('reload failed')
        mockPreloadStores.mockReturnValueOnce(Promise.reject(failure))
        const res = await login('owner@example.com', 'pw')
        expect(res.error).toBeNull()
        expect(res.user?.id).toBe('u1')
        await vi.waitFor(() =>
            expect(mockCaptureException).toHaveBeenCalledWith('auth-store.preloadStores', failure)
        )
    })
})
