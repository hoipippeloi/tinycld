// Pure on purpose: no react-native import and no generated import, so the
// generator (a Node script) and vitest can both load it. The platform-specific
// parts (the generated registry, Image.resolveAssetSource) are injected by
// use-help-image-resolver.ts.

export type HelpImageRegistry = Readonly<Record<string, number>>
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
 * Metro asset id to a fetchable URI (Image.resolveAssetSource on every
 * platform) or null when it cannot.
 */
export function createHelpImageResolver(
    registry: HelpImageRegistry,
    toUri: (assetId: number) => string | null,
    pkgSlug: string,
    theme: HelpImageTheme
): (uri: string) => string {
    return uri => {
        if (!isRelativeHelpRef(uri)) return uri
        const relative = normalizeHelpImageRef(uri)
        if (relative === null) return EMPTY_IMAGE_URI
        const key = `${pkgSlug}/${relative}`
        const darkKey = darkVariantKey(key)
        const assetId = theme === 'dark' && darkKey in registry ? registry[darkKey] : registry[key]
        if (assetId === undefined) return EMPTY_IMAGE_URI
        return toUri(assetId) ?? EMPTY_IMAGE_URI
    }
}

const IMAGE_SYNTAX = /!\[([^\]]*)\]\([^)]*\)/g

/** Body text for search: an image contributes its alt text, never its path. */
export function stripHelpImageSyntax(body: string): string {
    return body.replace(IMAGE_SYNTAX, '$1')
}
