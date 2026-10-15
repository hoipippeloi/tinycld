/** "On since 3 Oct 2026" style date for a factor's enabled or created time. */
export function formatSince(iso: string): string {
    if (!iso) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * A code the user typed to prove a factor: six digits go to the
 * authenticator check, anything else is tried as a recovery code.
 */
export function proofFromInput(value: string): { code: string } | { recoveryCode: string } {
    const compact = value.replace(/\s+/g, '')
    if (/^\d{6}$/.test(compact)) return { code: compact }
    return { recoveryCode: compact }
}
