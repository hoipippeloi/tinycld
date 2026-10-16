import type { NotifyChannel } from '@tinycld/core/lib/notify/channels/types'
import { composeNotifyRegistry } from '@tinycld/core/lib/notify/composed'
import {
    __setChannelsForTests,
    __setRegistryForTests,
    type NotifyInput,
    notify,
} from '@tinycld/core/lib/notify/dispatcher'
import { coreEvents } from '@tinycld/core/lib/notify/registry'
import { captureExceptionToSentry } from '@tinycld/core/lib/sentry'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

// A fictional package's events, augmented the way a package's events module
// does it, so the emits below type-check against the open event map.
// The augmentation is visible to the whole core program, so do not reuse
// `gizmos.widget_broke` outside this test.
declare module '@tinycld/core/lib/notify/events' {
    interface NotificationEvents {
        'gizmos.widget_broke': { id: string }
    }
}

// Channel modules are imported eagerly by the dispatcher; stub their deps so
// loading this test does not require runtime env (pocketbase client, RN APIs).
// Error paths below are expected; record them instead of printing to stderr.
vi.mock('@tinycld/core/lib/sentry', () => ({ captureExceptionToSentry: vi.fn() }))
vi.mock('@tinycld/core/lib/pocketbase', () => ({
    notificationsCollection: {
        insert: vi.fn(() => ({ when: () => Promise.resolve() })),
    },
}))
vi.mock('@tinycld/core/lib/notifications', () => ({
    showOsNotification: vi.fn(() => Promise.resolve()),
}))
vi.mock('@tinycld/core/lib/stores/toast-store', () => ({
    useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}))

function makeChannel(name: NotifyChannel['name']): NotifyChannel {
    return { name, dispatch: vi.fn() }
}

describe('notify.emit', () => {
    afterEach(() => {
        __setChannelsForTests(null)
        __setRegistryForTests(null)
        vi.clearAllMocks()
    })

    it('dispatches to exactly the channels named in the registry', () => {
        const toast = makeChannel('toast')
        const bell = makeChannel('bell')
        const os = makeChannel('os')
        __setChannelsForTests({ toast, bell, os })

        notify.emit({
            event: 'import.complete',
            title: 'Done',
            body: '42 contacts',
            data: { source: 'google-takeout', count: 42 },
        })

        expect(toast.dispatch).toHaveBeenCalledTimes(1)
        expect(bell.dispatch).toHaveBeenCalledTimes(1)
        expect(os.dispatch).not.toHaveBeenCalled()
    })

    it('merges the registry variant into the dispatch input', () => {
        const toast = makeChannel('toast')
        __setChannelsForTests({ toast, bell: makeChannel('bell'), os: makeChannel('os') })

        notify.emit({
            event: 'settings.avatar_upload_failed',
            title: 'Oops',
            data: { error: 'timeout' },
        })

        expect(toast.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ variant: 'error', title: 'Oops' })
        )
    })

    it('catches a synchronous channel throw and still runs later channels', () => {
        const toast = makeChannel('toast')
        toast.dispatch = vi.fn(() => {
            throw new Error('boom')
        })
        const bell = makeChannel('bell')
        __setChannelsForTests({ toast, bell, os: makeChannel('os') })

        expect(() =>
            notify.emit({
                event: 'import.complete',
                title: 'x',
                data: { source: 'csv', count: 1 },
            })
        ).not.toThrow()
        expect(bell.dispatch).toHaveBeenCalled()
        expect(captureExceptionToSentry).toHaveBeenCalledWith(
            'notify.channel.threw',
            expect.any(Error),
            { channel: 'toast' }
        )
    })

    it('swallows a channel rejection without affecting others', async () => {
        const toast = makeChannel('toast')
        toast.dispatch = vi.fn(() => Promise.reject(new Error('async-boom')))
        const bell = makeChannel('bell')
        __setChannelsForTests({ toast, bell, os: makeChannel('os') })

        notify.emit({
            event: 'import.complete',
            title: 'x',
            data: { source: 'csv', count: 1 },
        })

        // allow microtasks to flush
        await new Promise(r => setTimeout(r, 0))
        expect(bell.dispatch).toHaveBeenCalled()
        expect(captureExceptionToSentry).toHaveBeenCalledWith(
            'notify.channel.rejected',
            expect.any(Error),
            { channel: 'toast' }
        )
    })

    it('types a package event’s data from its augmentation', () => {
        expectTypeOf<NotifyInput<'gizmos.widget_broke'>['data']>().toEqualTypeOf<
            { id: string } | undefined
        >()
    })

    it('dispatches a package event with the package’s variant', () => {
        // The test config has no package declaring events; compose one here.
        __setRegistryForTests(
            composeNotifyRegistry(coreEvents, [
                {
                    manifest: { slug: 'gizmos' },
                    notifyEvents: {
                        'gizmos.widget_broke': { channels: ['toast'], variant: 'warning' },
                    },
                },
            ])
        )
        const toast = makeChannel('toast')
        const bell = makeChannel('bell')
        __setChannelsForTests({ toast, bell, os: makeChannel('os') })

        notify.emit({ event: 'gizmos.widget_broke', title: 'Broke', data: { id: 'w1' } })

        expect(toast.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'gizmos.widget_broke',
                variant: 'warning',
                data: { id: 'w1' },
            })
        )
        expect(bell.dispatch).not.toHaveBeenCalled()
        expect(captureExceptionToSentry).not.toHaveBeenCalled()
    })

    it('reports an unregistered event and dispatches nothing', () => {
        __setRegistryForTests(coreEvents)
        const toast = makeChannel('toast')
        __setChannelsForTests({ toast, bell: makeChannel('bell'), os: makeChannel('os') })

        notify.emit({ event: 'gizmos.widget_broke', title: 'Broke', data: { id: 'w1' } })

        expect(toast.dispatch).not.toHaveBeenCalled()
        expect(captureExceptionToSentry).toHaveBeenCalledWith(
            'notify.dispatcher',
            expect.any(Error)
        )
    })
})
