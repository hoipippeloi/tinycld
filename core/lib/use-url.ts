import {
    useGlobalSearchParams,
    useNavigationContainerRef,
    usePathname,
    useUnstableGlobalHref,
} from 'expo-router'
import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * The current URL: the one place the app reads it. Use this instead of
 * expo-router's usePathname / useGlobalSearchParams / useUnstableGlobalHref /
 * useSegments; biome refuses those imports everywhere but here.
 *
 * Why not expo-router's hooks: they merge the params of every route on the
 * focused path. A deep-linked URL writes ALL of its params onto every route of
 * the path (populateParams in expo-router's getStateFromPath), and a later
 * navigation updates only the navigator it changes. Close a card that was
 * opened by a link (`/a/boards/PL/PL-1` → `/a/boards/PL`) and the board's
 * parent routes still carry `card: 'PL-1'`, so useGlobalSearchParams keeps
 * reporting the closed card. Upstream calls it undefined behaviour and keeps
 * it (expo/expo#32241).
 *
 * The focused leaf route is the one route expo-router keeps current: every
 * navigation writes the full params of its URL down onto it. So the URL is
 * built from the leaf's params and the focused route names, and pathname,
 * params and href come from one snapshot and cannot disagree.
 *
 * For the params of the route a component is mounted in — which must NOT change
 * when another screen is pushed over it — keep using useLocalSearchParams.
 */

export type UrlParams = Record<string, string | string[]>

export interface Url<P extends object = UrlParams> {
    /** The path, without query or hash: `/a/boards/PL/PL-1`. */
    pathname: string
    /** The path's dynamic segments and the query params, decoded. */
    params: P
    /** Path, query and hash: `/a/mail?folder=sent`. */
    href: string
}

export interface NavRoute {
    name: string
    params?: object
    path?: string
    state?: NavState
}

export interface NavState {
    index?: number
    routes: NavRoute[]
}

const ROOT_SLOT = '__root'
const NOT_FOUND = '+not-found'
const SITEMAP = '_sitemap'

// The keys expo-router keeps in params that are not URL params: a nested
// navigation payload, and its own internal flags.
const isNavigationKey = (key: string) =>
    key === 'screen' || key === 'params' || key.startsWith('__internal')

function decode(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function urlParams(raw: object | undefined): UrlParams {
    const params: UrlParams = {}
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (isNavigationKey(key)) continue
        if (typeof value === 'string') params[key] = decode(value)
        else if (Array.isArray(value)) params[key] = value.map(v => decode(String(v)))
        else if (typeof value === 'number' || typeof value === 'boolean')
            params[key] = String(value)
    }
    return params
}

function routeSegments(name: string): string[] {
    return (name.startsWith('/') ? name.slice(1) : name).split('/')
}

/** The path segment a route name stands for: [] for a group or a missing optional param. */
function pathPart(segment: string, params: UrlParams, pathParams: Set<string>): string[] {
    if (segment.startsWith('(') && segment.endsWith(')')) return []
    if (segment === NOT_FOUND) {
        pathParams.add('not-found')
        const value = params['not-found']
        if (value === undefined) return []
        return Array.isArray(value) ? value : [value]
    }
    if (segment.startsWith('[...') && segment.endsWith(']')) {
        const name = segment.slice(4, -1).replace(/\?$/, '')
        pathParams.add(name)
        const value = params[name]
        if (value === undefined) return []
        return Array.isArray(value) ? value : [value]
    }
    if (segment.startsWith('[') && segment.endsWith(']')) {
        const name = segment.slice(1, -1)
        pathParams.add(name)
        const value = params[name]
        if (value === undefined || value === '') return []
        return [Array.isArray(value) ? value.join(',') : value]
    }
    return [segment]
}

function hrefOf(pathname: string, params: UrlParams, pathParams: Set<string>): string {
    const query = new URLSearchParams()
    let hash: string | undefined
    for (const [key, value] of Object.entries(params)) {
        if (pathParams.has(key)) continue
        if (key === '#') {
            hash = Array.isArray(value) ? value[0] : value
            continue
        }
        for (const v of Array.isArray(value) ? value : [value]) query.append(key, v)
    }
    const search = query.toString()
    return `${pathname}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`
}

const EMPTY_URL: Url = { pathname: '/', params: {}, href: '/' }

/**
 * The URL a root navigation state stands for. Exported for tests; components
 * use useUrl.
 */
export function urlFromState(state: NavState | undefined): Url {
    if (!state || state.routes.length === 0) return EMPTY_URL
    let route = state.routes[state.index ?? 0]
    if (route.name === NOT_FOUND || route.name === SITEMAP) {
        const path = route.path || (route.name === NOT_FOUND ? '/' : `/${route.name}`)
        return { pathname: path, params: {}, href: path }
    }

    const segments: string[] = []
    let current: NavState | undefined
    if (route.name === ROOT_SLOT) {
        current = route.state
    } else {
        segments.push(...routeSegments(route.name))
        current = route.state
    }
    let leafParams: object | undefined = route.name === ROOT_SLOT ? undefined : route.params
    while (current) {
        route = current.routes[current.index ?? 0]
        segments.push(...routeSegments(route.name))
        leafParams = route.params
        current = route.state
    }

    // A navigator that has not rendered yet holds the rest of the path as a
    // nested { screen, params } payload; its innermost params are the URL's.
    let payload = leafParams as { screen?: unknown; params?: unknown } | undefined
    while (payload && typeof payload.screen === 'string') {
        segments.push(...routeSegments(payload.screen))
        if (!payload.params || typeof payload.params !== 'object') break
        payload = payload.params as { screen?: unknown; params?: unknown }
    }
    const params = urlParams(payload ?? leafParams)

    if (segments[segments.length - 1] === 'index') segments.pop()
    const pathParams = new Set<string>()
    const pathname = `/${segments.flatMap(segment => pathPart(segment, params, pathParams)).join('/')}`
    return { pathname, params, href: hrefOf(pathname, params, pathParams) }
}

/**
 * The current URL. Re-renders on every navigation that changes it, and only
 * then: the result keeps its identity while the URL is the same. `P` names the
 * params a caller reads, as useGlobalSearchParams<P> did; every value is a
 * string, or a string array for a repeated param or a catch-all segment.
 */
export function useUrl<P extends object = UrlParams>(): Url<P> {
    const navigation = useNavigationContainerRef()
    // Until the navigation container is ready there is no state to read; the
    // route info expo-router computed from the initial URL is right then,
    // because nothing has navigated yet.
    const initial: Url = {
        pathname: usePathname(),
        params: useGlobalSearchParams() as UrlParams,
        href: useUnstableGlobalHref(),
    }
    const cache = useRef<{ key: string; url: Url } | null>(null)

    const subscribe = useCallback(
        (onChange: () => void) => {
            const offState = navigation.addListener('state', onChange)
            const offReady = navigation.addListener('ready', onChange)
            return () => {
                offState()
                offReady()
            }
        },
        [navigation]
    )

    const getSnapshot = () => {
        const url = navigation.isReady()
            ? urlFromState(navigation.getRootState() as unknown as NavState)
            : initial
        const key = JSON.stringify(url)
        if (cache.current?.key !== key) cache.current = { key, url }
        return cache.current.url
    }

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as Url<P>
}
