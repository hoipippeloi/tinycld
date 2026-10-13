import { describe, expect, it } from 'vitest'
import type { CatalogResponse } from '../api'
import type { RuleDraft } from '../draft'
import { emptyDraft } from '../draft'
import { ruleDraftSchemaFor } from '../rule-draft-schema'

// Mirrors Task 1's catalog fixture shape (see api.test.ts / catalog_test.go).
const catalog: CatalogResponse = {
    triggers: [
        { ref: 'core:manual', pkg: 'core', label: 'Run manually', synthetic: 'manual' },
        { ref: 'core:schedule', pkg: 'core', label: 'On a schedule', synthetic: 'schedule' },
        {
            ref: 'cat:item-created',
            pkg: 'cat',
            label: 'An item is created',
            collection: 'cat_items',
            fields: [
                { key: 'subject', label: 'Subject', type: 'text' },
                { key: 'has_attachments', label: 'Has attachments', type: 'boolean' },
                { key: 'size', label: 'Size', type: 'number' },
                { key: 'due', label: 'Due', type: 'date' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['new', 'done'],
                },
                {
                    key: 'folder',
                    label: 'Folder',
                    type: 'relation',
                    relationTarget: 'cat_folders',
                    displayField: 'name',
                },
            ],
        },
        {
            ref: 'cat:other-created',
            pkg: 'cat',
            label: 'An other-thing is created',
            collection: 'cat_others',
            fields: [{ key: 'subject', label: 'Subject', type: 'text' }],
        },
    ],
    actions: [
        {
            ref: 'core:notify',
            pkg: 'core',
            label: 'Notify',
            kind: 'native',
            available: true,
            params: [
                {
                    key: 'title',
                    label: 'Title',
                    field: { key: 'title', label: 'Title', type: 'text' },
                    template: true,
                },
            ],
        },
        {
            ref: 'core:unavailable-action',
            pkg: 'core',
            label: 'Unavailable',
            kind: 'native',
            available: false,
            params: [],
        },
        {
            ref: 'cat:set-folder',
            pkg: 'cat',
            label: 'Move to folder',
            kind: 'record-op',
            collection: 'cat_items',
            opType: 'update',
            opTarget: 'trigger-record',
            available: true,
            params: [
                {
                    key: 'folder',
                    label: 'Folder',
                    field: {
                        key: 'folder',
                        label: 'Folder',
                        type: 'relation',
                        relationTarget: 'cat_folders',
                        displayField: 'name',
                    },
                    template: false,
                },
            ],
        },
        {
            ref: 'cat:other-set-folder',
            pkg: 'cat',
            label: 'Move other to folder (different collection)',
            kind: 'record-op',
            collection: 'cat_others',
            opType: 'update',
            opTarget: 'trigger-record',
            available: true,
            params: [
                {
                    key: 'folder',
                    label: 'Folder',
                    field: {
                        key: 'folder',
                        label: 'Folder',
                        type: 'relation',
                        relationTarget: 'cat_folders',
                        displayField: 'name',
                    },
                    template: false,
                },
            ],
        },
    ],
}

function parse(draft: RuleDraft, against: CatalogResponse | undefined) {
    return ruleDraftSchemaFor(against).safeParse(draft)
}

function messages(draft: RuleDraft, against: CatalogResponse | undefined): string[] {
    const result = parse(draft, against)
    return result.success ? [] : result.error.issues.map(i => i.message)
}

function issuePaths(draft: RuleDraft, against: CatalogResponse | undefined) {
    const result = parse(draft, against)
    return result.success ? [] : result.error.issues.map(i => i.path)
}

describe('ruleDraftSchemaFor', () => {
    function validDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
        return {
            name: 'My rule',
            scope: 'personal',
            trigger: 'cat:item-created',
            triggerConfig: {},
            conditions: { match: 'all', groups: [] },
            actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
            enabled: true,
            stopProcessing: false,
            order: 0,
            ...overrides,
        }
    }

    it('accepts a valid draft', () => {
        expect(messages(validDraft(), catalog)).toEqual([])
    })

    it('returns no catalog-dependent errors when catalog is undefined, still requires name/trigger/actions', () => {
        expect(messages(emptyDraft('personal'), undefined)).toEqual([
            'Name is required',
            'Trigger is required',
            'At least one action is required',
        ])
        // An unknown trigger is only detectable against a catalog.
        expect(messages(validDraft({ trigger: 'cat:does-not-exist' }), undefined)).toEqual([])
    })

    it('requires a name', () => {
        const errors = messages(validDraft({ name: '  ' }), catalog)
        expect(errors.some(e => /name/i.test(e))).toBe(true)
    })

    it('rejects an unknown trigger', () => {
        const errors = messages(validDraft({ trigger: 'cat:does-not-exist' }), catalog)
        expect(errors.some(e => /trigger/i.test(e))).toBe(true)
    })

    it('rejects a condition field not present in the trigger catalog', () => {
        const draft = validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [{ field: 'not-a-field', op: 'contains', value: 'x' }],
                    },
                ],
            },
        })
        const errors = messages(draft, catalog)
        expect(errors.some(e => /not-a-field/.test(e))).toBe(true)
    })

    // A numeric operator whose value isn't a number fails closed in the engine
    // (toFloat can't read it), so the rule would silently never match. The
    // motivating case is a half-typed "" or "-" left in the value input.
    function numericDraft(value: unknown) {
        return validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [
                            { field: 'size', op: 'gt', value: value as string | number | boolean },
                        ],
                    },
                ],
            },
        })
    }

    it.each([
        ['an empty string', ''],
        ['a lone minus sign', '-'],
        ['undefined', undefined],
        ['a non-numeric string', 'abc'],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects a numeric condition whose value is %s', (_label, value) => {
        const errors = messages(numericDraft(value), catalog)
        expect(errors.some(e => /needs a number/i.test(e))).toBe(true)
    })

    it.each([
        ['a number', 5],
        ['zero', 0],
        ['a negative number', -3],
        ['a numeric string from an older build', '42'],
    ])('accepts a numeric condition whose value is %s', (_label, value) => {
        expect(messages(numericDraft(value), catalog)).toEqual([])
    })

    it('applies the numeric check to within_last_days on a date field', () => {
        const draft = validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [{ field: 'due', op: 'within_last_days', value: '' }],
                    },
                ],
            },
        })
        expect(messages(draft, catalog).some(e => /needs a number/i.test(e))).toBe(true)
    })

    it('leaves value-less operators alone', () => {
        const draft = validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [{ field: 'folder', op: 'is_empty' }],
                    },
                ],
            },
        })
        expect(messages(draft, catalog)).toEqual([])
    })

    it('rejects an operator illegal for the field type', () => {
        const draft = validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [{ field: 'has_attachments', op: 'contains', value: 'x' }],
                    },
                ],
            },
        })
        const errors = messages(draft, catalog)
        expect(errors.some(e => /operator/i.test(e))).toBe(true)
    })

    it('requires at least one action', () => {
        const errors = messages(validDraft({ actions: [] }), catalog)
        expect(errors.some(e => /action/i.test(e))).toBe(true)
    })

    it('rejects an action ref not in the catalog', () => {
        const errors = messages(
            validDraft({ actions: [{ ref: 'cat:does-not-exist', params: {} }] }),
            catalog
        )
        expect(errors.some(e => /does-not-exist/.test(e))).toBe(true)
    })

    it('rejects an unavailable action', () => {
        const errors = messages(
            validDraft({ actions: [{ ref: 'core:unavailable-action', params: {} }] }),
            catalog
        )
        expect(errors.some(e => /unavailable/i.test(e) || /available/i.test(e))).toBe(true)
    })

    it('rejects a trigger-record action targeting a different collection than the trigger', () => {
        // trigger is cat:item-created (collection cat_items); action targets cat_others
        const errors = messages(
            validDraft({
                actions: [{ ref: 'cat:other-set-folder', params: { folder: 'folder123456789' } }],
            }),
            catalog
        )
        expect(errors.some(e => /collection/i.test(e))).toBe(true)
    })

    it('rejects a synthetic-triggered rule that has conditions', () => {
        const draft = validDraft({
            trigger: 'core:manual',
            conditions: {
                match: 'all',
                groups: [
                    { match: 'all', conditions: [{ field: 'x', op: 'contains', value: 'y' }] },
                ],
            },
            actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
        })
        const errors = messages(draft, catalog)
        expect(errors.some(e => /condition/i.test(e))).toBe(true)
    })

    it('rejects a synthetic-triggered rule with a trigger-record action', () => {
        const draft = validDraft({
            trigger: 'core:manual',
            conditions: { match: 'all', groups: [] },
            actions: [{ ref: 'cat:set-folder', params: { folder: 'folder123456789' } }],
        })
        const errors = messages(draft, catalog)
        expect(errors.some(e => /trigger-record|synthetic/i.test(e))).toBe(true)
    })

    it('requires a non-empty cron for the schedule trigger', () => {
        const draft = validDraft({
            trigger: 'core:schedule',
            triggerConfig: {},
            actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
        })
        const errors = messages(draft, catalog)
        expect(errors.some(e => /cron/i.test(e))).toBe(true)
    })

    it('accepts the schedule trigger with a cron string', () => {
        const draft = validDraft({
            trigger: 'core:schedule',
            triggerConfig: { cron: '0 * * * *' },
            actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
        })
        expect(messages(draft, catalog)).toEqual([])
    })

    it('rejects a relation param left empty', () => {
        const errors = messages(
            validDraft({ actions: [{ ref: 'cat:set-folder', params: { folder: '' } }] }),
            catalog
        )
        expect(errors.length).toBeGreaterThan(0)
    })

    it('allows a text param to be an empty string', () => {
        const errors = messages(
            validDraft({ actions: [{ ref: 'core:notify', params: { title: '' } }] }),
            catalog
        )
        expect(errors).toEqual([])
    })

    it('allows a missing param key on a text param (treated as empty)', () => {
        const errors = messages(
            validDraft({ actions: [{ ref: 'core:notify', params: {} }] }),
            catalog
        )
        expect(errors).toEqual([])
    })
})

describe('ruleDraftSchemaFor issue paths', () => {
    function validDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
        return {
            name: 'My rule',
            scope: 'personal',
            trigger: 'cat:item-created',
            triggerConfig: {},
            conditions: { match: 'all', groups: [] },
            actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
            enabled: true,
            stopProcessing: false,
            order: 0,
            ...overrides,
        }
    }

    it('files the catalog-free rules on their own fields', () => {
        expect(issuePaths(emptyDraft('personal'), catalog)).toEqual([
            ['name'],
            ['trigger'],
            ['actions'],
        ])
    })

    it('still runs the catalog checks when the name is blank', () => {
        const draft = validDraft({
            name: '',
            actions: [{ ref: 'cat:set-folder', params: {} }],
        })
        expect(messages(draft, catalog)).toEqual([
            'Name is required',
            "Action 'Move to folder' requires 'Folder'",
        ])
    })

    it('files condition issues on the condition part that is wrong', () => {
        const draft = validDraft({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [
                            { field: 'nope', op: 'contains', value: 'x' },
                            { field: 'has_attachments', op: 'contains', value: 'x' },
                            { field: 'size', op: 'gt', value: '' },
                        ],
                    },
                ],
            },
        })
        expect(issuePaths(draft, catalog)).toEqual([
            ['conditions', 'groups', 0, 'conditions', 0, 'field'],
            ['conditions', 'groups', 0, 'conditions', 1, 'op'],
            ['conditions', 'groups', 0, 'conditions', 2, 'value'],
        ])
    })

    it('files conditions on a synthetic trigger against the whole condition set', () => {
        const draft = validDraft({
            trigger: 'core:manual',
            conditions: {
                match: 'all',
                groups: [
                    { match: 'all', conditions: [{ field: 'x', op: 'contains', value: 'y' }] },
                ],
            },
        })
        expect(issuePaths(draft, catalog)).toEqual([['conditions']])
    })

    it('files the missing cron on the cron', () => {
        expect(issuePaths(validDraft({ trigger: 'core:schedule' }), catalog)).toEqual([
            ['triggerConfig', 'cron'],
        ])
    })

    it('files an unknown trigger on the trigger', () => {
        expect(issuePaths(validDraft({ trigger: 'cat:does-not-exist' }), catalog)).toEqual([
            ['trigger'],
        ])
    })

    // Not `actions.N.ref`: react-hook-form keeps a field's DOM ref under an
    // error's `ref` key, so FormErrorSummary skips an error filed there.
    it('files action-level issues on the action, then param issues under it', () => {
        const draft = validDraft({
            actions: [
                { ref: 'cat:does-not-exist', params: {} },
                { ref: 'cat:other-set-folder', params: {} },
            ],
        })
        expect(issuePaths(draft, catalog)).toEqual([
            ['actions', 0],
            ['actions', 1],
            ['actions', 1, 'params', 'folder'],
        ])
    })

    it('trims the name in the parsed draft and keeps every other field', () => {
        const draft = validDraft({ id: 'rule123456789012', name: '  My rule  ' })
        const result = parse(draft, catalog)
        expect(result.success).toBe(true)
        expect(result.data).toEqual({ ...draft, name: 'My rule' })
    })

    it('rejects a whitespace-only name', () => {
        expect(messages(validDraft({ name: '   ' }), catalog)).toEqual(['Name is required'])
    })
})
