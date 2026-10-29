import { helpImages } from '@tinycld/app-generated/package-help'
import { Image } from 'react-native'
import { useUniwind } from 'uniwind'
import { createHelpImageResolver, type HelpImageAsset, type HelpImageTheme } from './images'

type ImageUriTransform = (uri: string) => string

// Only native hands back an asset id, which is just as well: react-native-web
// has no Image.resolveAssetSource. Web's require() already carries the URI.
function assetUri(asset: HelpImageAsset): string | null {
    if (typeof asset === 'number') return Image.resolveAssetSource(asset)?.uri ?? null
    if (typeof asset === 'string') return asset
    return asset.uri
}

// MarkdownRenderer caches renderers by the IDENTITY of transformImageUri, so a
// fresh closure per render would grow that cache without bound. There are only
// (packages x 2 themes) distinct resolvers; build each once.
const resolvers = new Map<string, ImageUriTransform>()

export function helpImageResolverFor(pkgSlug: string, theme: HelpImageTheme): ImageUriTransform {
    const key = `${pkgSlug}|${theme}`
    const cached = resolvers.get(key)
    if (cached) return cached
    const resolver = createHelpImageResolver(helpImages, assetUri, pkgSlug, theme)
    resolvers.set(key, resolver)
    return resolver
}

export function useHelpImageResolver(pkgSlug: string): ImageUriTransform {
    const { theme } = useUniwind()
    return helpImageResolverFor(pkgSlug, theme === 'dark' ? 'dark' : 'light')
}
