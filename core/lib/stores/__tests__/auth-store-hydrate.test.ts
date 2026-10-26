// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cold-boot hydration must open the app as soon as the session is known. The
// store warm-up (reload + preloads) only fills what the first screens' live
// queries load anyway, so awaiting it before hasHydrated held the whole app on
// a blank screen for the warm-up's duration — sign-in already runs it in the
// background (see adoptAuthResponse), and hydrate mirrors that order.

const fullRecord = { id: 'user_owner', name: 'Dana Reyes', email: 'dana@example.com' }
const authStore = {
    save: vi.fn(),
    clear: vi.fn(),
    onChange: vi.fn(() => () => {}),
    token: null as string | null,
    record: null as unknown,
}
const calls: string[] = []
const mockRefreshAuth = vi.fn()
const mockGetUser = vi.fn()
const mockSeedUser = vi.fn()
const mockPreloadStores = vi.fn()
const mockCaptureException = vi.fn()

vi.mock('@tinycld/core/lib/pocketbase', () => ({
    PB_SERVER_ADDR: 'http://localhost:8090',
    pb: { authStore, collection: vi.fn() },
    authStoreReady: Promise.resolve(),
    getUserFromAuthStore: () => mockGetUser(),
    seedUser: (record: unknown) => mockSeedUser(record),
    preloadStores: () => mockPreloadStores(),
    resetSessionState: vi.fn(() => Promise.resolve()),
    refreshAuth: () => mockRefreshAuth(),
}))

vi.mock('@tinycld/core/lib/errors', () => ({
    captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

vi.mock('@tinycld/core/lib/logger', () => ({
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@tinycld/core/lib/store', () => ({
    create: () => (fn: unknown) => {
        let state = {} as Record<string, unknown>
        const set = (patch: Record<string, unknown>) => {
            state = { ...state, ...patch }
        }
        type Factory = (
            set: (patch: Record<string, unknown>) => void,
            get: () => Record<string, unknown>
        ) => Record<string, unknown>
        state = { ...state, ...(fn as Factory)(set, () => state) }
        const store = (selector: (s: typeof state) => unknown) => selector(state)
        store.getState = () => state
        store.setState = set
        return store
    },
    persist: <T>(fn: T) => fn,
    asyncStorage: undefined,
}))

type Store = {
    getState: () => { user: unknown; hasHydrated: boolean; initAuth: () => () => void }
}

const authenticatedUser = { ...fullRecord, isDemo: false, isBetaTester: false }

async function loadStore(): Promise<Store> {
    const mod = await import('../auth-store')
    return mod.useAuthStore as unknown as Store
}

describe('auth-store hydrate', () => {
    beforeEach(() => {
        vi.resetModules()
        calls.length = 0
        authStore.record = null
        authStore.token = null
        mockRefreshAuth.mockReset()
        mockGetUser.mockReset()
        mockSeedUser.mockReset()
        mockPreloadStores.mockReset()
        mockCaptureException.mockReset()
    })

    it('opens the app once the session is known, with the warm-up still running', async () => {
        mockRefreshAuth.mockImplementation(async () => {
            calls.push('refreshAuth')
            authStore.token = 'token'
            authStore.record = fullRecord
            return true
        })
        mockGetUser.mockReturnValue(authenticatedUser)
        mockSeedUser.mockImplementation(async () => {
            calls.push('seedUser')
        })
        // Never settles within the test: hydration must not depend on it.
        mockPreloadStores.mockImplementation(() => {
            calls.push('preloadStores')
            return new Promise(() => {})
        })

        const store = await loadStore()
        store.getState().initAuth()

        await vi.waitFor(() => expect(store.getState().hasHydrated).toBe(true))
        expect(store.getState().user).toEqual(authenticatedUser)
        expect(mockSeedUser).toHaveBeenCalledWith(fullRecord)
        expect(calls).toEqual(['refreshAuth', 'seedUser', 'preloadStores'])
    })

    it('hydrates signed out when the stored token is dead', async () => {
        mockRefreshAuth.mockResolvedValue(false)
        mockGetUser.mockReturnValue(null)

        const store = await loadStore()
        store.getState().initAuth()

        await vi.waitFor(() => expect(store.getState().hasHydrated).toBe(true))
        expect(store.getState().user).toBeNull()
        expect(mockSeedUser).not.toHaveBeenCalled()
        expect(mockPreloadStores).not.toHaveBeenCalled()
    })

    it('keeps the user signed in when the seed fails', async () => {
        mockRefreshAuth.mockImplementation(async () => {
            authStore.token = 'token'
            authStore.record = fullRecord
            return true
        })
        mockGetUser.mockReturnValue(authenticatedUser)
        mockSeedUser.mockRejectedValue(new Error('offline'))
        mockPreloadStores.mockResolvedValue(undefined)

        const store = await loadStore()
        store.getState().initAuth()

        await vi.waitFor(() => expect(store.getState().hasHydrated).toBe(true))
        expect(store.getState().user).toEqual(authenticatedUser)
        expect(mockCaptureException).toHaveBeenCalledWith(
            'auth-store.initAuth.seedUser',
            expect.any(Error)
        )
    })
})
