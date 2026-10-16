// The first half of a web server handoff (see server-handoff.ts): take the
// parameter out of the URL before the router reads it.
//
// No imports on purpose. The bundle entry runs this ahead of expo-router, before
// config is registered, and route layouts load as async chunks on web — so by
// the time app/_layout.tsx runs, the router has already read the URL and would
// write the parameter back.

export const HANDOFF_PARAM = 'from-server'

export interface HandoffArrival {
    href: string
    referrer: string
}

let arrival: HandoffArrival | null = null

export function captureServerHandoff(): void {
    // `window` exists on native too, but without a location or history.
    if (typeof window === 'undefined' || !window.location?.href || !window.history?.replaceState) {
        return
    }
    const url = new URL(window.location.href)
    if (!url.searchParams.has(HANDOFF_PARAM)) return

    arrival = { href: url.toString(), referrer: document.referrer }
    url.searchParams.delete(HANDOFF_PARAM)
    window.history.replaceState(window.history.state, '', url.toString())
}

// Returns the captured arrival once; later calls get null.
export function takeServerHandoff(): HandoffArrival | null {
    const taken = arrival
    arrival = null
    return taken
}
