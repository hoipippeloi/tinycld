import { describe, expect, it } from 'vitest'
import { definitionSchema, validateDefinitionForHost } from '../definition'
import layoutDefinition from '../fixtures/layout-definition.json'
import layoutHosts from '../fixtures/layout-hosts.json'
import { defaultDefinitionFor, hostDefListSchema } from '../host'

// layout-hosts.json is the generator's emitted shape for a host with a layout,
// and layout-definition.json the exact JSON the Go seed writes for it
// (core/server/forms seed_test.go asserts it byte for byte), so the TS and Go
// seeds of a host layout cannot drift apart. Its set_value action has a null value,
// which both seeds write as `"value": null`: the shape definitionSchema gives
// back when it parses that action, so a stored form re-reads unchanged.
describe('the default definition of a host with a layout', () => {
    const [host] = hostDefListSchema.parse(layoutHosts.hosts)

    it('parses the emitted host without losing its layout', () => {
        const emitted = layoutHosts.hosts.map(({ pkgSlug: _pkgSlug, ...rest }) => rest)
        expect(hostDefListSchema.parse(layoutHosts.hosts)).toEqual(emitted)
    })

    it('matches what the server seeds', () => {
        expect(defaultDefinitionFor(host)).toEqual(layoutDefinition)
    })

    it('parses and is valid for its host', () => {
        const parsed = definitionSchema.safeParse(layoutDefinition)
        expect(parsed.error?.issues ?? []).toEqual([])
        expect(parsed.success && validateDefinitionForHost(parsed.data, host)).toEqual([])
    })
})
