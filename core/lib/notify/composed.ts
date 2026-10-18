import { tinycldConfig } from '@tinycld/app-generated/tinycld-config'
import { coreEvents, type EventConfig, type PackageNotifyEvents } from './registry'

type NotifyEntryLike = {
    manifest: { slug: string }
    notifyEvents?: PackageNotifyEvents
}

function sameConfig(a: EventConfig, b: EventConfig): boolean {
    return a.variant === b.variant && a.channels.join(',') === b.channels.join(',')
}

/**
 * Core's events plus every installed package's, keyed by event name. A
 * package owns its names; two packages (or a package and core) naming the
 * same event with different policy is a programming error, so it throws at
 * boot rather than letting whichever loaded last win.
 */
export function composeNotifyRegistry(
    core: Record<string, EventConfig>,
    entries: readonly NotifyEntryLike[]
): Record<string, EventConfig> {
    const out: Record<string, EventConfig> = { ...core }
    const owner: Record<string, string> = Object.fromEntries(
        Object.keys(core).map(k => [k, 'core'])
    )
    for (const entry of entries) {
        const slug = entry.manifest.slug
        for (const [name, config] of Object.entries(entry.notifyEvents ?? {})) {
            const existing = out[name]
            if (existing && !sameConfig(existing, config)) {
                throw new Error(
                    `notify event ${name} is declared by ${owner[name]} and again by ${slug} with a different policy`
                )
            }
            out[name] = config
            owner[name] ??= slug
        }
    }
    return out
}

// Under Metro's CJS output an import cycle leaves tinycldConfig undefined
// here, and the composer would fail with an opaque "undefined is not iterable".
if (!tinycldConfig) {
    throw new Error(
        'notify: tinycldConfig read during its own initialisation — a module tinycld.config imports reaches the notify dispatcher'
    )
}

/** Static for the life of the app, like the package registry. */
export const notifyRegistry = composeNotifyRegistry(
    coreEvents,
    tinycldConfig as readonly NotifyEntryLike[]
)
