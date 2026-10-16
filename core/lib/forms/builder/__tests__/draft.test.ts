import { describe, expect, it } from 'vitest'
import { bugDefinition } from '../../__tests__/fixtures'
import { definitionSchema } from '../../definition'
import {
    addField,
    addPage,
    addRule,
    moveField,
    movePage,
    newCustomField,
    normalizeDraft,
    PageNotEmpty,
    referencesOf,
    removeField,
    removePage,
    removeRule,
    renamePage,
} from '../draft'

const def = definitionSchema.parse({
    ...bugDefinition,
    defaults: { severity: 'low', steps: 'see above' },
    submit: { required: ['title', 'steps'] },
})

describe('newCustomField', () => {
    it('derives a unique key from the label and fills kind defaults', () => {
        const f = newCustomField('select', 'Severity', 'details', new Set(['severity']))
        expect(f).toMatchObject({
            key: 'severity_2',
            kind: 'select',
            page: 'details',
            label: 'Severity',
            width: 'full',
            required: false,
            hidden: false,
            display: 'dropdown',
            multiple: false,
        })
        expect(f.kind === 'select' && f.options).toEqual([{ value: 'option_1', label: 'Option 1' }])
    })
    it('never re-derives the key on rename', () => {
        const f = newCustomField('text', 'Severity', 'details', new Set())
        const renamed = { ...f, label: 'Sev' }
        expect(renamed.key).toBe('severity')
    })
})

describe('addField / moveField', () => {
    it('appends to the end of the page by default and inserts at an index', () => {
        const f = newCustomField('toggle', 'Blocking', 'details', new Set())
        const appended = addField(def, f)
        expect(appended.fields.at(-1)?.key).toBe('blocking')
        const inserted = addField(def, f, 1)
        expect(inserted.fields[1]?.key).toBe('blocking')
    })
    it('moves a field to another page at an index', () => {
        const moved = moveField(def, 'severity', 'repro', 0)
        const repro = moved.fields.filter(f => f.page === 'repro').map(f => f.key)
        expect(repro).toEqual(['severity', 'steps'])
    })
    it('reorders within a page', () => {
        const moved = moveField(def, 'severity', 'details', 0)
        expect(moved.fields.map(f => f.key)).toEqual(['severity', 'title', 'steps'])
    })
})

describe('removeField', () => {
    it('drops the field and every reference to it', () => {
        const { definition, removed } = removeField(def, 'steps')
        expect(definition.fields.map(f => f.key)).toEqual(['title', 'severity'])
        expect(definition.rules?.[0]?.actions).toEqual([{ action: 'show', page: 'repro' }])
        expect(definition.defaults).toEqual({ severity: 'low' })
        expect(definition.submit?.required).toEqual(['title'])
        expect(removed).toEqual({ rules: [], actions: 1, defaults: true, submitRequired: true })
    })
    it('keeps a rule that only loses one of several actions', () => {
        const two = definitionSchema.parse({
            ...def,
            rules: [
                {
                    ...def.rules[0],
                    actions: [...def.rules[0].actions, { action: 'hide', field: 'severity' }],
                },
            ],
        })
        const { definition, removed } = removeField(two, 'steps')
        expect(definition.rules?.[0]?.actions).toEqual([
            { action: 'show', page: 'repro' },
            { action: 'hide', field: 'severity' },
        ])
        expect(removed).toEqual({ rules: [], actions: 1, defaults: true, submitRequired: true })
    })
    it('refuses to remove a builtin', () => {
        expect(() => removeField(def, 'title')).toThrow(/built-in/)
    })
    it('referencesOf reports without changing', () => {
        expect(referencesOf(def, 'severity')).toEqual({
            rules: ['r1'],
            actions: 0,
            defaults: true,
            submitRequired: false,
        })
    })
})

describe('pages', () => {
    it('adds a page with a unique key from its title', () => {
        const next = addPage(def, 'Details')
        expect(next.pages.map(p => p.key)).toEqual(['details', 'repro', 'details_2'])
    })
    it('renames and moves a page', () => {
        expect(renamePage(def, 'repro', 'Steps').pages[1]?.title).toBe('Steps')
        expect(movePage(def, 'repro', 0).pages.map(p => p.key)).toEqual(['repro', 'details'])
    })
    it('refuses to remove a page with fields, removes an empty one and its rule targets', () => {
        expect(() => removePage(def, 'repro')).toThrow(PageNotEmpty)
        const emptied = moveField(def, 'steps', 'details', 2)
        const { definition, removed } = removePage(emptied, 'repro')
        expect(definition.pages.map(p => p.key)).toEqual(['details'])
        expect(definition.rules?.[0]?.actions).toEqual([{ action: 'require', field: 'steps' }])
        expect(removed.actions).toBe(1)
    })
    it('refuses to remove the last page', () => {
        const one = definitionSchema.parse({
            ...def,
            pages: [def.pages[0]],
            fields: def.fields.map(f => ({ ...f, page: 'details' })),
            rules: [],
        })
        expect(() => removePage(one, 'details')).toThrow(/last page/)
    })
})

describe('rules', () => {
    it('adds an empty rule with a unique key and removes by key', () => {
        const next = addRule(def)
        expect(next.rules).toHaveLength(2)
        expect(next.rules?.[1]).toEqual({ key: 'rule', match: 'all', when: [], actions: [] })
        expect(removeRule(next, 'r1').rules?.map(r => r.key)).toEqual(['rule'])
    })
})

describe('empty draft rules', () => {
    it('keeps an empty rule when a field is removed', () => {
        const withEmpty = addRule(def)
        const { definition } = removeField(withEmpty, 'severity')
        expect(definition.rules?.map(r => r.key)).toContain('rule')
    })
})

describe('normalizeDraft', () => {
    it('fills field and rule defaults and empties rules, defaults and submit', () => {
        const draft = {
            ...def,
            fields: [
                { key: 'title', page: 'details', label: 'Title', kind: 'builtin' as const },
                {
                    key: 'severity',
                    page: 'details',
                    label: 'Severity',
                    kind: 'select' as const,
                    options: [{ value: 'low', label: 'Low' }],
                },
            ],
            rules: [{ key: 'r1', when: [], actions: [] }],
        }
        const normalized = normalizeDraft(draft)
        expect(normalized.fields[0]).toMatchObject({
            width: 'full',
            required: false,
            hidden: false,
        })
        expect(normalized.fields[1]).toMatchObject({
            display: 'dropdown',
            multiple: false,
            width: 'full',
        })
        expect(normalized.rules).toEqual([])
        expect(normalized.defaults).toEqual({})
        expect(normalized.submit).toEqual({ required: [] })
    })
})
