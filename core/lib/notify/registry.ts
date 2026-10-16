import type { NotifyEventName } from '@tinycld/core/lib/notify/events'

/** `'os'` is wired into the dispatcher but not yet used by any event — opt in when a future event needs native/browser push. */
export type ChannelName = 'toast' | 'bell' | 'os'
export type Variant = 'info' | 'success' | 'warning' | 'error'

export type EventConfig = {
    /** Channels fire in array order; failures in one do not block the next. */
    channels: ChannelName[]
    variant: Variant
}

/** What a package's `notifications.events` module exports: its events and their policy. */
export type PackageNotifyEvents = Record<string, EventConfig>

/**
 * Policy for core's own events. TypeScript requires one entry per core
 * event name; a package's events are declared by the package (see
 * PackageNotifyEvents) and merged in ./composed.ts.
 */
export const coreEvents: Record<NotifyEventName, EventConfig> = {
    'import.complete': { channels: ['toast', 'bell'], variant: 'success' },
    'import.failed': { channels: ['toast', 'bell'], variant: 'error' },
    'files.pick_rejected': { channels: ['toast'], variant: 'error' },
    'mutation.error': { channels: ['toast'], variant: 'error' },
    'account.password_changed': { channels: ['toast'], variant: 'success' },
    'account.security_changed': { channels: ['toast'], variant: 'success' },
    'account.security_copied': { channels: ['toast'], variant: 'success' },
    'settings.avatar_upload_failed': { channels: ['toast'], variant: 'error' },
    'settings.branding_upload_failed': { channels: ['toast'], variant: 'error' },
}

// Replaced by the composed registry in the next commit.
export const eventRegistry = coreEvents
