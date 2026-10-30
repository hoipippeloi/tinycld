// Module-lifetime guard so we register the device's push token at most once
// per app session, even as the hook re-mounts across route changes. It's
// module-scoped (not a component ref) so logout can reset it — otherwise a
// second user signing in on the same running SPA/app would never get their
// own registration. resetExpoPushRegistration() clears it from logout.
//
// It lives in its own module with no imports: the auth store resets it on
// logout, and the registration hook reads auth, so keeping it in the hook's
// module made a require cycle (auth → auth-store → hook → auth).
let registered = false

export function isExpoPushRegistered(): boolean {
    return registered
}

export function markExpoPushRegistered(): void {
    registered = true
}

export function resetExpoPushRegistration(): void {
    registered = false
}
