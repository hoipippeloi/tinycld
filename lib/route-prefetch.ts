// Fetch route chunks before the router asks for them.
//
// On web every route file is its own chunk (app.json asyncRoutes), wrapped in
// React.lazy by Expo Router. A lazy route whose chunk is not yet loaded
// suspends, commits a fallback, and then waits out React's 300ms Suspense
// throttle before it can show content — once per nested layout, so a cold
// boot paid about three of them in a row. Expo's async-require returns a chunk
// that has already run synchronously, and Expo Router mounts such a route
// without suspending. So loading the chunks for a pathname first, and
// rendering second, removes the fallbacks without changing what is bundled:
// each route stays its own chunk, fetched only when its URL is about to show.

import { log } from '@tinycld/core/lib/logger'
import { appHref } from '@tinycld/core/lib/org-routes'
import { packageSidebars } from '@tinycld/core/lib/packages/derive-components'
import { routeKeysFor } from '@tinycld/core/lib/route-keys'
import { ctx } from 'expo-router/_ctx'
import importMode from 'expo-router/build/import-mode'
import { useMemo, useSyncExternalStore } from 'react'

// Expo Router only wraps routes in React.lazy in this mode; otherwise ctx(key)
// is a plain synchronous require and there is nothing to fetch ahead. Read
// from the router's own module: babel inlines EXPO_ROUTER_IMPORT_MODE there,
// but not in app code, where process.env would read as unset.
const LAZY_ROUTES = importMode === 'lazy'

type Loader = () => unknown

const started = new Map<string, Promise<void>>()
const settled = new Set<string>()
const listeners = new Set<() => void>()

function notify() {
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

// A failed fetch is not reported here: the router (or the sidebar boundary)
// requests the same chunk next and surfaces the failure through its own
// recovery path. The prefetch only has to stop waiting.
function load(id: string, loader: Loader): Promise<void> {
    const existing = started.get(id)
    if (existing) return existing
    const pending = Promise.resolve()
        .then(loader)
        .then(
            () => undefined,
            (err: unknown) => log.debug('core.route-prefetch', 'chunk prefetch failed', { id, err })
        )
        .finally(() => {
            settled.add(id)
            notify()
        })
    started.set(id, pending)
    return pending
}

function routeLoaders(pathname: string): [string, Loader][] {
    return routeKeysFor(pathname, ctx.keys()).map(key => [key, () => ctx(key)])
}

function hasPreload(component: object): component is { preload: Loader } {
    return typeof (component as { preload?: unknown }).preload === 'function'
}

function sidebarLoader(slug: string): [string, Loader][] {
    const sidebar = packageSidebars[slug]
    if (!sidebar || !hasPreload(sidebar)) return []
    return [[`sidebar:${slug}`, sidebar.preload]]
}

/**
 * Chunks for the URL the page opened on. Returns null when there is nothing to
 * wait for (sync routes, native) so the entry can render synchronously.
 */
export function prefetchBootRoutes(): Promise<void> | null {
    if (!LAZY_ROUTES || typeof window === 'undefined') return null
    const loaders = routeLoaders(window.location.pathname)
    return Promise.all(loaders.map(([id, loader]) => load(id, loader))).then(() => undefined)
}

/**
 * True once the route chunks and sidebar for a package landing are loaded.
 * Loading starts on subscribe; a null slug waits for nothing. The landing
 * redirect holds its skeleton until this is true, so the package screen and
 * its sidebar mount without a fallback.
 */
export function usePackagePrefetch(slug: string | null): boolean {
    const loaders = useMemo(
        () => (slug && LAZY_ROUTES ? [...routeLoaders(appHref(slug)), ...sidebarLoader(slug)] : []),
        [slug]
    )
    const subscribeAndLoad = useMemo(
        () => (listener: () => void) => {
            const unsubscribe = subscribe(listener)
            for (const [id, loader] of loaders) load(id, loader)
            return unsubscribe
        },
        [loaders]
    )
    return useSyncExternalStore(
        subscribeAndLoad,
        () => loaders.every(([id]) => settled.has(id)),
        () => true
    )
}
