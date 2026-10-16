/**
 * Slots core renders for packages. Packages target them from
 * `sidebarContributions` with `target: 'core'`. The generator reads this list
 * to validate those contributions, so a typo fails the build instead of
 * rendering nothing. `group-member-removal` receives `GroupMemberRemovalNoticeProps`.
 */
export const CORE_SLOT_TARGET = 'core'
export const CORE_SLOTS = ['setup-team', 'group-member-removal'] as const
