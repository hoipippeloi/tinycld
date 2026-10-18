export const MEMBER_DRAWER_SLOT = 'member-drawer'

/**
 * Core renders this slot in the Settings → Members drawer, below the person's
 * groups. A package adds a section about that person. The contribution reads
 * its own package's collections and renders its own heading
 * (`text-[12px] font-semibold text-muted uppercase tracking-wide`). Only
 * admins see the drawer, because its screen is admin-only.
 */
export interface MemberDrawerPanelProps {
    userId: string
}
