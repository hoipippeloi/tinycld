'use client'
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator'
import { ToastProvider } from '@gluestack-ui/core/toast/creator'
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from '@tinycld/core/lib/color-themes'
import { OverlayProvider as SurfaceOverlayProvider } from '@tinycld/core/ui/overlay'
import React, { useEffect, useLayoutEffect } from 'react'
import { Uniwind } from 'uniwind'
import { script } from './script'

export type ModeType = 'light' | 'dark' | 'system'

const useSafeLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const MODES: ReadonlySet<ModeType> = new Set<ModeType>(['light', 'dark', 'system'])
const COLOR_THEME_SLUGS: ReadonlySet<string> = new Set(COLOR_THEMES.map(t => t.slug))

// mode/colorTheme originate from user_preferences via unvalidated `as` casts and
// reach the document through `script()`. Validate both against their allowlists.
const safeMode = (mode: string): ModeType =>
    MODES.has(mode as ModeType) ? (mode as ModeType) : 'dark'
const safeColorTheme = (colorTheme?: string): string =>
    colorTheme && COLOR_THEME_SLUGS.has(colorTheme) ? colorTheme : DEFAULT_COLOR_THEME

export function GluestackUIProvider({
    mode = 'dark',
    colorTheme,
    ...props
}: {
    mode?: ModeType
    colorTheme?: string
    children?: React.ReactNode
}) {
    const validMode = safeMode(mode)
    const validColorTheme = safeColorTheme(colorTheme)

    const handleMediaQuery = React.useCallback(
        (e: MediaQueryListEvent) => {
            const resolvedMode = e.matches ? 'dark' : 'light'
            script(resolvedMode, validColorTheme)
            Uniwind.setTheme(resolvedMode)
        },
        [validColorTheme]
    )

    useSafeLayoutEffect(() => {
        if (validMode === 'system') return
        script(validMode, validColorTheme)
        Uniwind.setTheme(validMode)
    }, [validMode, validColorTheme])

    useSafeLayoutEffect(() => {
        if (validMode !== 'system') return
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        media.addListener(handleMediaQuery)
        return () => media.removeListener(handleMediaQuery)
    }, [handleMediaQuery, validMode])

    // No inline theme-init <script>: the web output is a client-rendered SPA
    // (app.json `web.output: "single"`), and a script React renders on the client
    // never runs. The layout effects above apply the theme before paint.
    return (
        <>
            {/* Our own overlay host (dialogs, sheets, popovers, menus) wraps
                gluestack's, which now serves only its toasts and drawers.
                OUTSIDE it, not inside: gluestack renders a drawer's content as
                a sibling of its own children, so a menu opened from a drawer
                must find our provider above that level. Our root host also
                renders after gluestack's portal items, so it paints above
                them. See docs/overlays.md. */}
            <SurfaceOverlayProvider>
                <OverlayProvider>
                    <ToastProvider>{props.children}</ToastProvider>
                </OverlayProvider>
            </SurfaceOverlayProvider>
        </>
    )
}
