import { describe, expect, it } from 'vitest'
import { handoffOrigin, switchUrlFor } from '../server-handoff'

const SERVER_A = 'https://a.example.com'
const SERVER_B = 'https://b.example.com'

function arrivalFrom(named: string): string {
    return `${SERVER_B}/a/mail?from-server=${encodeURIComponent(named)}`
}

describe('switchUrlFor', () => {
    it('names the current server in the target URL', () => {
        const url = new URL(switchUrlFor(SERVER_B, SERVER_A))
        expect(url.origin).toBe(SERVER_B)
        expect(url.searchParams.get('from-server')).toBe(SERVER_A)
    })

    it('returns the target unchanged when the current server is unknown', () => {
        expect(switchUrlFor(SERVER_B, null)).toBe(SERVER_B)
    })
})

describe('handoffOrigin', () => {
    it('accepts a server the referrer confirms', () => {
        expect(handoffOrigin(arrivalFrom(SERVER_A), `${SERVER_A}/`)).toBe(SERVER_A)
    })

    it('ignores a page load with no handoff', () => {
        expect(handoffOrigin(`${SERVER_B}/a/mail`, `${SERVER_A}/`)).toBeNull()
    })

    // A link from anywhere else must not add a server the user never came from.
    it('rejects a server the referrer does not match', () => {
        expect(handoffOrigin(arrivalFrom(SERVER_A), 'https://evil.example.com/')).toBeNull()
    })

    // Referrer-Policy: no-referrer, or a privacy extension, leaves it empty.
    it('rejects a handoff with no referrer', () => {
        expect(handoffOrigin(arrivalFrom(SERVER_A), '')).toBeNull()
    })

    it('rejects a handoff naming the server it arrived on', () => {
        expect(handoffOrigin(arrivalFrom(SERVER_B), `${SERVER_B}/`)).toBeNull()
    })

    it('rejects a scheme that is not http or https', () => {
        expect(handoffOrigin(arrivalFrom('javascript:alert(1)'), 'javascript:alert(1)')).toBeNull()
    })

    it('saves the origin, not the full address it was given', () => {
        const from = `${SERVER_A}/a/mail/inbox`
        expect(handoffOrigin(arrivalFrom(from), `${SERVER_A}/`)).toBe(SERVER_A)
    })
})
