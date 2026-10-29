// @vitest-environment happy-dom

// While automatic updates are on, the version pickers are locked. A set staged
// before the lock (or in another tab, or while the status was loading) must not
// stay applicable behind them, whichever path turned the switch on. The server
// fetch is the boundary here; the staging store is the real one.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type PocketBase from 'pocketbase'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tinycld/core/lib/server-fetch', () => ({
    serverFetch: vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, violations: [] }) })
    ),
}))

import { usePackageVersions } from '../use-package-versions'
import { useVersionStagingStore } from '../version-staging-store'

function wrapper() {
    const client = new QueryClient()
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
}

const pb = { authStore: { token: 't' } } as unknown as PocketBase

describe('usePackageVersions while versions are locked', () => {
    beforeEach(() => {
        useVersionStagingStore.getState().clear()
        useVersionStagingStore.getState().setTarget('mail', '0.9.0', '0.8.1')
    })

    it('has nothing to apply while locked', () => {
        const { result } = renderHook(() => usePackageVersions(pb, false, true), {
            wrapper: wrapper(),
        })
        expect(result.current.pendingChanges).toEqual([])
        expect(result.current.targets).toEqual({})
        expect(result.current.canApply).toBe(false)
    })

    it('shows the staged set again when unlocked', () => {
        const { result, rerender } = renderHook(
            ({ isLocked }) => usePackageVersions(pb, false, isLocked),
            { wrapper: wrapper(), initialProps: { isLocked: true } }
        )
        rerender({ isLocked: false })
        expect(result.current.pendingChanges).toHaveLength(1)
        expect(result.current.pendingChanges[0]).toMatchObject({
            slug: 'mail',
            targetVersion: '0.9.0',
        })
    })
})
