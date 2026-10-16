import { coreEvents } from '@tinycld/core/lib/notify/registry'
import { describe, expect, it } from 'vitest'

describe('core notify events', () => {
    it('names no package: every core event is import., files., mutation., account. or settings.', () => {
        for (const name of Object.keys(coreEvents)) {
            expect(name).toMatch(/^(import|files|mutation|account|settings)\./)
        }
    })
})
