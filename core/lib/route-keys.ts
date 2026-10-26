// Which files of an Expo Router `app/` tree mount for a URL. Used to fetch the
// route chunks for a pathname before the router asks for them, so each lazy
// route resolves synchronously on its first render (see lib/route-prefetch.ts
// in the app shell). A spare match costs one small chunk; a miss costs a
// Suspense fallback plus React's 300ms throttle, so matching errs wide.

const GROUP_SEGMENT = /^\(.*\)$/
const ROUTE_FILE_SUFFIX = /(\.(web|android|ios|native))?\.[tj]sx?$/

function routeSegments(key: string): string[] {
    return key
        .replace(/^\.\//, '')
        .replace(ROUTE_FILE_SUFFIX, '')
        .split('/')
        .filter(segment => !GROUP_SEGMENT.test(segment))
}

function segmentMatches(routeSegment: string, urlSegment: string): boolean {
    return routeSegment === urlSegment || routeSegment.startsWith('[')
}

function fileMatches(name: string, remaining: number, urlSegment: string | undefined): boolean {
    if (name === '_layout') return true
    if (name === 'index') return remaining === 0
    if (name.startsWith('[...')) return remaining >= 1
    if (name.startsWith('[')) return remaining === 1
    return remaining === 1 && name === urlSegment
}

/** Route context keys (`./a/(app)/mail/_layout.tsx`) that render `pathname`. */
export function routeKeysFor(pathname: string, keys: readonly string[]): string[] {
    const url = pathname.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
    return keys.filter(key => {
        const segments = routeSegments(key)
        const name = segments[segments.length - 1]
        const dir = segments.slice(0, -1)
        if (dir.length > url.length) return false
        if (dir.some((segment, i) => !segmentMatches(segment, url[i]))) return false
        return fileMatches(name, url.length - dir.length, url[dir.length])
    })
}
