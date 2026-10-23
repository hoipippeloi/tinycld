import { NotificationDrawer } from '@tinycld/core/components/NotificationDrawer'
import { useWorkspaceStore } from '@tinycld/core/lib/stores/workspace-store'
import { OverlayHost } from '@tinycld/core/ui/overlay'
import { MobileDrawer } from './MobileDrawer'
import { MobileTabBar } from './MobileTabBar'
import { MoreDrawer } from './MoreDrawer'

// Mobile-only chrome, rendered by WorkspaceLayout as siblings of the shared
// package tree. WorkspaceLayout keeps one tree shape across breakpoints so
// PackageProviderWrapper and PackageTabs never remount; these components render
// null off-mobile instead of being swapped in as a different root.

/** Rendered INSIDE the content box. */
export function MobileOverlays({ isVisible, isReady }: { isVisible: boolean; isReady: boolean }) {
    if (!isVisible) return null
    return (
        <>
            {/* Bottom sheets render here, so they rest on the tab bar
                rather than sliding under it. */}
            <OverlayHost name="sheet" />
            {isReady && <MoreDrawer />}
            {isReady && <NotificationDrawer mobile />}
        </>
    )
}

/** Rendered AFTER the content box: edge-anchored chrome that bleeds to the screen edge. */
export function MobileChrome({ isVisible, isReady }: { isVisible: boolean; isReady: boolean }) {
    const isDrawerOpen = useWorkspaceStore(s => s.isDrawerOpen)
    if (!isVisible || !isReady) return null
    return (
        <>
            <MobileTabBar />
            <MobileDrawer isVisible={isDrawerOpen} />
        </>
    )
}
