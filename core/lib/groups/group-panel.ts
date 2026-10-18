export const GROUP_DRAWER_SLOT = 'group-drawer'

/**
 * Core renders this slot in the Settings → Groups drawer, below the members
 * list. A package adds a section about that group. The contribution reads its
 * own package's collections and renders its own heading
 * (`text-[12px] font-semibold text-muted uppercase tracking-wide`). Only
 * admins see the drawer, because its screen is admin-only.
 */
export interface GroupDrawerPanelProps {
    groupId: string
}
