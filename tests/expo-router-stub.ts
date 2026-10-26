// Test-only stub for expo-router. The real package's CJS entry (build/index.js)
// follows source maps to src/exports.ts which contains JSX that Vite's SSR
// node environment cannot parse. This stub provides the minimal API used at
// module-top by package source files so the module graph can finish loading.

import { createContext, useContext, useSyncExternalStore } from 'react'
import { vi } from 'vitest'

const noop = () => {}

/**
 * The screen a hook under test runs in: its path, and the navigation object
 * `useNavigation` returns. A test wraps the hook in `<ScreenStub value={…}>`;
 * outside one, the hooks answer as before: a screen at '/' with an empty
 * navigation object.
 */
export interface ScreenStubValue {
    pathname: string
    navigation: { isFocused: () => boolean; dispatch: (action: unknown) => void }
}
const ScreenStubContext = createContext<ScreenStubValue | null>(null)
export const ScreenStub = ScreenStubContext.Provider
const ComponentStub = () => null

/**
 * The router's current path, shared by every mounted screen as in the app,
 * where `usePathname` and `useUrl` answer the focused screen's path in every
 * screen: a covered screen re-renders with the covering screen's path. A test
 * sets it with `setRouterPathname`; while it is null (the default), each
 * screen answers its own `ScreenStub` path, or '/'.
 */
let routerPathname: string | null = null
const routerListeners = new Set<() => void>()

export function setRouterPathname(pathname: string | null) {
    if (pathname === routerPathname) return
    routerPathname = pathname
    for (const listener of routerListeners) listener()
}

function subscribeToRouter(listener: () => void) {
    routerListeners.add(listener)
    return () => {
        routerListeners.delete(listener)
    }
}

const readRouterPathname = () => routerPathname

export const router = {
    push: vi.fn(noop),
    replace: vi.fn(noop),
    back: vi.fn(noop),
    canGoBack: vi.fn(() => true),
    setParams: vi.fn(noop),
    navigate: vi.fn(noop),
    dismissAll: vi.fn(noop),
    dismiss: vi.fn(noop),
}

export const Link = ComponentStub
export const Stack = Object.assign(ComponentStub, { Screen: ComponentStub })
export const Tabs = Object.assign(ComponentStub, { Screen: ComponentStub })
export const Slot = ComponentStub
export const Redirect = ComponentStub
export const Drawer = Object.assign(ComponentStub, { Screen: ComponentStub })

export const useRouter = () => router
export const usePathname = () => {
    const shared = useSyncExternalStore(subscribeToRouter, readRouterPathname, readRouterPathname)
    const screen = useContext(ScreenStubContext)
    return shared ?? screen?.pathname ?? '/'
}
export const useSegments = () => []
export const useLocalSearchParams = () => ({})
export const useGlobalSearchParams = () => ({})
export const useUnstableGlobalHref = () => '/'
export const useNavigationContainerRef = () => ({
    isReady: () => false,
    addListener: () => noop,
})
export const useFocusEffect = (_cb: () => void) => {}
export const useNavigation = () => useContext(ScreenStubContext)?.navigation ?? {}
export const useRootNavigationState = () => ({ key: 'test' })
export const Href = undefined
