import { log } from './logger'
import { probeServer } from './server-address'
import { HANDOFF_PARAM, takeServerHandoff } from './server-handoff-capture'
import { addServer, isSameServer } from './servers'

// A browser cannot read another origin's storage, so a web server list only
// learns about the servers this browser switched between. A switch from A to B
// names A in B's URL, and B saves A — after one trip each lists the other.

// switchUrlFor is the address a web switch navigates to: the target, naming the
// server the user is leaving so the target can offer the way back.
export function switchUrlFor(target: string, current: string | null): string {
    if (!current) return target
    try {
        const url = new URL(target)
        url.searchParams.set(HANDOFF_PARAM, current)
        return url.toString()
    } catch {
        return target
    }
}

function originOf(address: string): string | null {
    try {
        const url = new URL(address)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
        return url.origin
    } catch {
        return null
    }
}

// handoffOrigin returns the server a page load was handed off from, or null.
//
// The referrer must agree with the parameter: a link anywhere else cannot add an
// entry by naming a server the user never came from.
export function handoffOrigin(href: string, referrer: string): string | null {
    const page = new URL(href)
    const named = page.searchParams.get(HANDOFF_PARAM)
    if (!named) return null

    const from = originOf(named)
    const referrerOrigin = originOf(referrer)
    if (!from || !referrerOrigin) return null
    if (!isSameServer(from, referrerOrigin)) return null
    if (isSameServer(from, page.origin)) return null
    return from
}

// acceptServerHandoff saves the server a web switch came from. The bundle entry
// already took the parameter out of the URL (server-handoff-capture.ts); this
// runs once config is registered, because the probe needs it.
export function acceptServerHandoff(): void {
    const arrival = takeServerHandoff()
    if (!arrival) return
    const from = handoffOrigin(arrival.href, arrival.referrer)
    if (!from) return

    // Only a server that answers like one is saved, so a page that is not a
    // TinyCld server cannot put itself in the switcher.
    probeServer(from)
        .then(() => addServer(from))
        .catch(err => {
            log.info('servers.handoff', 'did not save the previous server', {
                from,
                error: err instanceof Error ? err.message : String(err),
            })
        })
}
