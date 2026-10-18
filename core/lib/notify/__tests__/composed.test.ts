import { composeNotifyRegistry } from '@tinycld/core/lib/notify/composed'
import { coreEvents } from '@tinycld/core/lib/notify/registry'
import { describe, expect, it } from 'vitest'

const toastError = { channels: ['toast' as const], variant: 'error' as const }
const toastWarn = { channels: ['toast' as const], variant: 'warning' as const }

describe('composeNotifyRegistry', () => {
    it('holds only core events with no packages installed', () => {
        expect(composeNotifyRegistry(coreEvents, [])).toEqual(coreEvents)
    })

    it('merges each package’s events under its own policy', () => {
        const out = composeNotifyRegistry(coreEvents, [
            { manifest: { slug: 'gizmos' }, notifyEvents: { 'gizmos.widget_broke': toastWarn } },
            { manifest: { slug: 'widgets' } },
        ])
        expect(out['gizmos.widget_broke']).toEqual(toastWarn)
        expect(out['mutation.error']).toEqual(coreEvents['mutation.error'])
    })

    it('refuses a package that redefines an event with a different policy', () => {
        expect(() =>
            composeNotifyRegistry(coreEvents, [
                { manifest: { slug: 'gizmos' }, notifyEvents: { 'shared.thing': toastError } },
                { manifest: { slug: 'widgets' }, notifyEvents: { 'shared.thing': toastWarn } },
            ])
        ).toThrow(/shared\.thing.*gizmos.*widgets|shared\.thing.*widgets.*gizmos/)
    })

    it('refuses a package that redefines a core event', () => {
        expect(() =>
            composeNotifyRegistry(coreEvents, [
                { manifest: { slug: 'gizmos' }, notifyEvents: { 'mutation.error': toastWarn } },
            ])
        ).toThrow(/mutation\.error.*core.*gizmos/)
    })

    it('accepts an identical duplicate', () => {
        const out = composeNotifyRegistry(coreEvents, [
            { manifest: { slug: 'gizmos' }, notifyEvents: { 'shared.thing': toastError } },
            { manifest: { slug: 'widgets' }, notifyEvents: { 'shared.thing': toastError } },
        ])
        expect(out['shared.thing']).toEqual(toastError)
    })
})
