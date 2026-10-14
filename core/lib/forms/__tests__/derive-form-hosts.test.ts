import { describe, expect, it } from 'vitest'
import { deriveFormHosts } from '../../packages/derive-form-hosts'
import { widgetHost } from './fixtures'

describe('deriveFormHosts', () => {
    it('collects hosts with their package slug and ui loader', async () => {
        const ui = { components: {}, mappers: {} }
        const hosts = deriveFormHosts([
            {
                manifest: { name: 'Gizmos', slug: 'gizmos' },
                formHosts: [widgetHost],
                formHostsUi: async () => ({ default: ui }),
            },
            { manifest: { name: 'Plain', slug: 'plain' } },
        ])
        expect(hosts).toHaveLength(1)
        expect(hosts[0]).toMatchObject({ key: 'gizmos:widget', pkgSlug: 'gizmos' })
        await expect(hosts[0].ui()).resolves.toBe(ui)
    })
    it('returns an empty ui when a package declares hosts without a ui module', async () => {
        const hosts = deriveFormHosts([
            { manifest: { name: 'Gizmos', slug: 'gizmos' }, formHosts: [widgetHost] },
        ])
        await expect(hosts[0].ui()).resolves.toEqual({ components: {}, mappers: {} })
    })
})
