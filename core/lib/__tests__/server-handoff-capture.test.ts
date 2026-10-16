// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { captureServerHandoff, takeServerHandoff } from '../server-handoff-capture'

beforeEach(() => {
    window.history.replaceState(null, '', '/')
    takeServerHandoff()
})

describe('captureServerHandoff', () => {
    // The router reads the URL right after; a parameter left there is written
    // back on every navigation.
    it('takes the handoff out of the URL and keeps the rest', () => {
        window.history.replaceState(
            null,
            '',
            '/a/mail?tab=1&from-server=https%3A%2F%2Fa.example.com'
        )
        captureServerHandoff()

        expect(window.location.search).toBe('?tab=1')
        expect(window.location.pathname).toBe('/a/mail')
        const arrival = takeServerHandoff()
        expect(new URL(arrival?.href ?? '').searchParams.get('from-server')).toBe(
            'https://a.example.com'
        )
    })

    it('gives the arrival out only once', () => {
        window.history.replaceState(null, '', '/?from-server=https%3A%2F%2Fa.example.com')
        captureServerHandoff()

        expect(takeServerHandoff()).not.toBeNull()
        expect(takeServerHandoff()).toBeNull()
    })

    it('leaves a URL with no handoff alone', () => {
        window.history.replaceState(null, '', '/a/mail?tab=1')
        captureServerHandoff()

        expect(window.location.search).toBe('?tab=1')
        expect(takeServerHandoff()).toBeNull()
    })
})
