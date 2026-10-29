// Pure on purpose: no react-native import and no generated import, so the
// generator (a Node script) and vitest can both load it. The platform-specific
// parts (the generated registry, the asset-to-URI step) are injected by
// use-help-image-resolver.ts.

// What Metro's require() of an image yields. Native gets an asset id; on web
// Expo's asset transformer emits { uri, width, height }, or a bare path when
// the size is unknown.
export type HelpImageAsset = number | string | { uri: string }
export type HelpImageRegistry = Readonly<Record<string, HelpImageAsset>>
export type HelpImageTheme = 'light' | 'dark'

// Rendered for a relative ref that matches no shipped file, so a typo can never
// become a request for a relative URL against the deployment's host.
export const EMPTY_IMAGE_URI =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const SCHEME_OR_ROOT = /^([a-z][a-z0-9+.-]*:|\/)/i

/** True for a ref authored relative to the package's help/ directory. */
export function isRelativeHelpRef(ref: string): boolean {
    return !SCHEME_OR_ROOT.test(ref)
}

/** `./images/a.png` → `images/a.png`; null when the ref climbs out of help/. */
export function normalizeHelpImageRef(ref: string): string | null {
    const parts = ref.replace(/^(\.\/)+/, '').split('/')
    if (parts.includes('..')) return null
    return parts.join('/')
}

/** `x/a.png` → `x/a.dark.png`. */
export function darkVariantKey(key: string): string {
    return key.replace(/(\.[^./]+)$/, '.dark$1')
}

/**
 * Builds the `transformImageUri` for one package and theme. `toUri` maps a
 * registry asset to a fetchable URI, or null when it cannot.
 */
export function createHelpImageResolver(
    registry: HelpImageRegistry,
    toUri: (asset: HelpImageAsset) => string | null,
    pkgSlug: string,
    theme: HelpImageTheme
): (uri: string) => string {
    return uri => {
        if (!isRelativeHelpRef(uri)) return uri
        const relative = normalizeHelpImageRef(uri)
        if (relative === null) return EMPTY_IMAGE_URI
        const key = `${pkgSlug}/${relative}`
        const darkKey = darkVariantKey(key)
        const asset = theme === 'dark' && darkKey in registry ? registry[darkKey] : registry[key]
        if (asset === undefined) return EMPTY_IMAGE_URI
        return toUri(asset) ?? EMPTY_IMAGE_URI
    }
}

const IMAGE_SYNTAX = /!\[([^\]]*)\]\([^)]*\)/g

/** Body text for search: an image contributes its alt text, never its path. */
export function stripHelpImageSyntax(body: string): string {
    return body.replace(IMAGE_SYNTAX, '$1')
}
