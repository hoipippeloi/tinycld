import { describe, expect, it } from 'vitest'
import { definitionSchema, validateDefinitionForHost } from '../definition'
import seeded from '../fixtures/seeded-definition.json'
import { defaultDefinitionFor } from '../host'
import { widgetHost } from './fixtures'

// The file holds the exact JSON the Go seed writes for the widget host
// (core/server/forms seed_test.go asserts it byte for byte), so a seed the
// client would drop fails here.
describe('the definition the server seeds', () => {
    it('parses and is valid for its host', () => {
        const parsed = definitionSchema.safeParse(seeded)
        expect(parsed.error?.issues ?? []).toEqual([])
        expect(parsed.success && validateDefinitionForHost(parsed.data, widgetHost)).toEqual([])
    })
    it('matches what the client would seed', () => {
        expect(definitionSchema.parse(seeded)).toEqual(defaultDefinitionFor(widgetHost))
    })
})
