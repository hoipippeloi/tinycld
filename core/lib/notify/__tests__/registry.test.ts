import type { NotificationEvents } from '@tinycld/core/lib/notify/events'
import { coreEvents } from '@tinycld/core/lib/notify/registry'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('core notify events', () => {
    it('names no package: every core event is import., files., mutation., account. or settings.', () => {
        for (const name of Object.keys(coreEvents)) {
            expect(name).toMatch(/^(import|files|mutation|account|settings)\./)
        }
    })

    it('is an interface a package can extend', () => {
        type Augmented = NotificationEvents & { 'gizmos.widget_broke': { id: string } }
        expectTypeOf<keyof Augmented>().toMatchTypeOf<string>()
        expectTypeOf<Augmented['gizmos.widget_broke']>().toEqualTypeOf<{ id: string }>()
    })
})
