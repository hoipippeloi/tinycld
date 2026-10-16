/**
 * The user-facing notification events core itself emits. Keys follow
 * `<domain>.<verb_past>`.
 *
 * An interface, not a type alias, so a package extends it from its own
 * events module with
 * `declare module '@tinycld/core/lib/notify/events' { interface NotificationEvents { … } }`.
 * Core never lists a package's events: the package declares them through the
 * manifest's `notifications.events` module, and the dispatcher's registry is
 * composed from every installed package at boot (see ./composed.ts).
 */
export interface NotificationEvents {
    'import.complete': { source: string; count: number }
    'import.failed': { source: string; error: string }
    // A picked file the picker refused — size or type — in any package.
    'files.pick_rejected': { reason: string }
    'mutation.error': { operation: string; error: string }
    'account.password_changed': Record<string, never>
    // A second factor, passkey or app password was added or removed.
    'account.security_changed': Record<string, never>
    'account.security_copied': Record<string, never>
    'settings.avatar_upload_failed': { error: string }
    'settings.branding_upload_failed': { error: string }
}

export type NotifyEventName = keyof NotificationEvents
