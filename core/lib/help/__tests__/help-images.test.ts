import { describe, expect, it } from 'vitest'
import {
    createHelpImageResolver,
    darkVariantKey,
    EMPTY_IMAGE_URI,
    type HelpImageAsset,
    isRelativeHelpRef,
    normalizeHelpImageRef,
    stripHelpImageSyntax,
} from '../images'

const registry = {
    'gizmos/images/a.png': 1,
    'gizmos/images/a.dark.png': 2,
    'gizmos/images/b.png': 3,
    'widgets/images/a.png': 4,
}
const toUri = (asset: HelpImageAsset) => `asset://${String(asset)}`

describe('help image refs', () => {
    it('treats scheme, protocol-relative and root-absolute refs as non-relative', () => {
        expect(isRelativeHelpRef('images/a.png')).toBe(true)
        expect(isRelativeHelpRef('./images/a.png')).toBe(true)
        expect(isRelativeHelpRef('https://x.test/a.png')).toBe(false)
        expect(isRelativeHelpRef('data:image/png;base64,AAAA')).toBe(false)
        expect(isRelativeHelpRef('/a.png')).toBe(false)
    })

    it('normalizes a leading ./ and rejects parent traversal', () => {
        expect(normalizeHelpImageRef('./images/a.png')).toBe('images/a.png')
        expect(normalizeHelpImageRef('images/a.png')).toBe('images/a.png')
        expect(normalizeHelpImageRef('../secret.png')).toBeNull()
        expect(normalizeHelpImageRef('images/../../x.png')).toBeNull()
    })

    it('derives the dark variant key before the extension', () => {
        expect(darkVariantKey('gizmos/images/a.png')).toBe('gizmos/images/a.dark.png')
        expect(darkVariantKey('gizmos/images/a.JPEG')).toBe('gizmos/images/a.dark.JPEG')
    })
})

describe('createHelpImageResolver', () => {
    it('resolves a relative ref in light mode', () => {
        const resolve = createHelpImageResolver(registry, toUri, 'gizmos', 'light')
        expect(resolve('images/a.png')).toBe('asset://1')
        expect(resolve('./images/a.png')).toBe('asset://1')
    })

    it('prefers the dark variant in dark mode', () => {
        const resolve = createHelpImageResolver(registry, toUri, 'gizmos', 'dark')
        expect(resolve('images/a.png')).toBe('asset://2')
    })

    it('falls back to the light image when no dark variant ships', () => {
        const resolve = createHelpImageResolver(registry, toUri, 'gizmos', 'dark')
        expect(resolve('images/b.png')).toBe('asset://3')
    })

    it('scopes lookups to the owning package', () => {
        const resolve = createHelpImageResolver(registry, toUri, 'widgets', 'light')
        expect(resolve('images/a.png')).toBe('asset://4')
        expect(resolve('images/b.png')).toBe(EMPTY_IMAGE_URI)
    })

    it('passes absolute URLs through and blanks unresolved relative refs', () => {
        const resolve = createHelpImageResolver(registry, toUri, 'gizmos', 'light')
        expect(resolve('https://x.test/a.png')).toBe('https://x.test/a.png')
        expect(resolve('images/missing.png')).toBe(EMPTY_IMAGE_URI)
        expect(resolve('../other/images/a.png')).toBe(EMPTY_IMAGE_URI)
    })

    // Web's asset transformer yields { uri, width, height } rather than an id.
    it('hands a web asset object to the platform resolver unchanged', () => {
        const web = { 'gizmos/images/a.png': { uri: '/assets/gizmos/help/images/a.png' } }
        const resolve = createHelpImageResolver(
            web,
            asset => (typeof asset === 'object' ? asset.uri : null),
            'gizmos',
            'light'
        )
        expect(resolve('images/a.png')).toBe('/assets/gizmos/help/images/a.png')
    })

    it('blanks an asset id the platform cannot resolve', () => {
        const resolve = createHelpImageResolver(registry, () => null, 'gizmos', 'light')
        expect(resolve('images/a.png')).toBe(EMPTY_IMAGE_URI)
    })
})

describe('stripHelpImageSyntax', () => {
    it('keeps alt text and drops the path', () => {
        expect(stripHelpImageSyntax('Before ![Create invoice](images/x.png) after')).toBe(
            'Before Create invoice after'
        )
    })

    it('leaves links alone', () => {
        expect(stripHelpImageSyntax('See [docs](https://x.test/png)')).toBe(
            'See [docs](https://x.test/png)'
        )
    })
})
