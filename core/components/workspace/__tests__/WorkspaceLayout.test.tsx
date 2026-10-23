// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The package screens live inside PackageTabs' expo-router <Tabs> navigator.
// expo-router is third-party, so stand a probe in for the navigator: it is the
// "package screen" whose mount identity and local state the layout must keep
// when the breakpoint changes. It is mounted wherever PackageTabs places Tabs.
const lifecycle = { mounts: 0, unmounts: 0 }

// Generated per-workspace icon map; its deep lucide imports carry Flow syntax
// Node cannot parse, and the layout does not depend on which icons exist.
vi.mock('@tinycld/app-generated/package-icons', () => ({ packageIcons: {} }))

// Same data seam as use-pkg-access.test.tsx: pbtsdb is replaced by local-only
// collections, so usePackage / useActivePkgDenied run their real queries.
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'u1', email: 'me@example.com' } }),
}))

vi.mock('@tinycld/core/lib/pocketbase', async () => {
    const { createCollection, localOnlyCollectionOptions } = await import('@tanstack/db')
    const mk = (id: string, initialData: { id: string; role?: string }[]) =>
        createCollection(
            localOnlyCollectionOptions({
                id,
                getKey: (r: { id: string; role?: string }) => r.id,
                initialData,
            })
        )
    const collections: Record<string, unknown> = {
        pkg_registry: mk('pkg-registry', []),
        users: mk('users', [{ id: 'u1', role: 'owner' }]),
        org_pkg_access: mk('org-pkg-access', []),
    }
    return { useStore: (...names: string[]) => names.map(n => collections[n]) }
})

vi.mock('expo-router', async () => {
    const { useEffect, useState } = await import('react')
    function ScreenProbe() {
        const [draft, setDraft] = useState('')
        useEffect(() => {
            lifecycle.mounts += 1
            return () => {
                lifecycle.unmounts += 1
            }
        }, [])
        return (
            <input
                data-testid="screen-probe"
                value={draft}
                onChange={e => setDraft(e.target.value)}
            />
        )
    }
    return {
        Tabs: ScreenProbe,
        router: { replace: vi.fn(), push: vi.fn(), back: vi.fn() },
        usePathname: () => '/',
        useLocalSearchParams: () => ({}),
        useGlobalSearchParams: () => ({}),
    }
})

import { WorkspaceLayout } from '@tinycld/core/components/workspace/WorkspaceLayout'
import { loadPackageProviders } from '@tinycld/core/lib/packages/provider-loader'
import { useWindowSizeStore } from '@tinycld/core/lib/stores/window-size-store'
import { OverlayProvider } from '@tinycld/core/ui/overlay'

const WIDTHS = { mobile: 390, tablet: 800, desktop: 1280 } as const

function resizeTo(name: keyof typeof WIDTHS) {
    act(() => {
        useWindowSizeStore.getState().setSize(WIDTHS[name], 800)
    })
}

function probe(container: HTMLElement) {
    return container.querySelector('[data-testid="screen-probe"]') as HTMLInputElement | null
}

// The root layout gate awaits this before mounting the workspace.
beforeAll(async () => {
    await loadPackageProviders()
})

beforeEach(() => {
    lifecycle.mounts = 0
    lifecycle.unmounts = 0
})

afterEach(() => {
    cleanup()
})

describe('WorkspaceLayout breakpoint changes', () => {
    it('keeps the PackageTabs subtree mounted across mobile, desktop, tablet and back', () => {
        useWindowSizeStore.getState().setSize(WIDTHS.mobile, 800)
        const { container } = render(
            <OverlayProvider>
                <WorkspaceLayout isReady={false} />
            </OverlayProvider>
        )

        act(() => {
            fireEvent.change(probe(container) as HTMLInputElement, { target: { value: 'draft' } })
        })
        expect(probe(container)?.value).toBe('draft')

        for (const name of ['desktop', 'tablet', 'mobile'] as const) {
            resizeTo(name)
            expect(probe(container), `probe present at ${name}`).not.toBeNull()
            expect(lifecycle, `probe lifecycle at ${name}`).toEqual({ mounts: 1, unmounts: 0 })
            expect(probe(container)?.value, `draft kept at ${name}`).toBe('draft')
        }
    })
})
