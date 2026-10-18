import { describe, expect, it } from 'vitest'
import { bugDefinition, widgetHost } from '../../__tests__/fixtures'
import { definitionSchema } from '../../definition'
import { defaultDefinitionFor } from '../../host'
import { actionsFor, catalogFieldFor, kindOf, NO_VALUE_OPS, operatorsFor } from '../catalog'

const def = definitionSchema.parse({
    ...defaultDefinitionFor(widgetHost),
    pages: [...defaultDefinitionFor(widgetHost).pages, ...bugDefinition.pages],
    fields: [...defaultDefinitionFor(widgetHost).fields, bugDefinition.fields[1]],
})

describe('kindOf / catalogFieldFor', () => {
    it('resolves a builtin through the host and a custom field directly', () => {
        expect(kindOf(def, widgetHost, 'due')).toBe('date')
        expect(kindOf(def, widgetHost, 'severity')).toBe('select')
        expect(kindOf(def, widgetHost, 'comments')).toBe('section')
    })
    it('maps kinds to the ValueInput catalog types', () => {
        expect(catalogFieldFor(def, widgetHost, 'name')).toEqual({
            key: 'name',
            label: 'Name',
            type: 'text',
        })
        expect(catalogFieldFor(def, widgetHost, 'due')).toEqual({
            key: 'due',
            label: 'Due',
            type: 'date',
        })
        expect(catalogFieldFor(def, widgetHost, 'severity')).toEqual({
            key: 'severity',
            label: 'Severity',
            type: 'select',
            options: ['low', 'high'],
        })
        expect(catalogFieldFor(def, widgetHost, 'owner')).toEqual({
            key: 'owner',
            label: 'Owner',
            type: 'relation',
            relationTarget: 'users',
            displayField: 'name',
        })
        expect(catalogFieldFor(def, widgetHost, 'tasks')).toEqual({
            key: 'tasks',
            label: 'Tasks',
            type: 'boolean',
        })
        expect(catalogFieldFor(def, widgetHost, 'ghost')).toBeUndefined()
    })
})

describe('operatorsFor / actionsFor', () => {
    it('reads OPERATORS_BY_KIND and knows which take no value', () => {
        expect(operatorsFor('date')).toEqual(['before', 'after', 'is_empty', 'not_empty'])
        expect(operatorsFor('section')).toEqual([])
        expect(NO_VALUE_OPS.has('is_empty')).toBe(true)
        expect(NO_VALUE_OPS.has('is')).toBe(false)
    })
    it('offers set_options only for select targets and show/hide for pages', () => {
        expect(actionsFor('select')).toEqual([
            'show',
            'hide',
            'require',
            'set_options',
            'set_value',
        ])
        expect(actionsFor('text')).toEqual(['show', 'hide', 'require', 'set_value'])
        expect(actionsFor('section')).toEqual(['show', 'hide'])
        expect(actionsFor('page')).toEqual(['show', 'hide'])
    })
    it('offers no set_value for a kind the builder has no value editor for', () => {
        for (const kind of ['checklist', 'file', 'custom'])
            expect(actionsFor(kind)).toEqual(['show', 'hide', 'require'])
    })
})
