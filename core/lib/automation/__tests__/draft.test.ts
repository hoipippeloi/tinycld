import type { Rules } from '@tinycld/core/types/pbSchema'
import { describe, expect, it } from 'vitest'
import { addCondition, addGroup, updateCondition } from '../condition-helpers'
import type { RuleDraft } from '../draft'
import { draftToRecord, emptyDraft, recordToDraft } from '../draft'

function baseRecord(overrides: Partial<Rules> = {}): Rules {
    return {
        id: 'rule123456789012',
        name: 'My rule',
        scope: 'personal',
        owner: 'user123456789012',
        trigger: 'cat:item-created',
        trigger_config: {},
        conditions: { match: 'all', groups: [] },
        actions: [{ ref: 'core:notify', params: { title: 'hi' } }],
        enabled: true,
        order: 0,
        stop_processing: false,
        created: '2026-01-01 00:00:00.000Z',
        updated: '2026-01-01 00:00:00.000Z',
        ...overrides,
    }
}

describe('emptyDraft', () => {
    it('has the requested scope and blank defaults', () => {
        const draft = emptyDraft('org')
        expect(draft.scope).toBe('org')
        expect(draft.id).toBeUndefined()
        expect(draft.name).toBe('')
        expect(draft.trigger).toBe('')
        expect(draft.conditions).toEqual({ match: 'all', groups: [] })
        expect(draft.actions).toEqual([])
        expect(draft.enabled).toBe(true)
        expect(draft.stopProcessing).toBe(false)
        expect(draft.order).toBe(0)
    })

    it('seeds order from the optional second argument (defaults to 0)', () => {
        expect(emptyDraft('personal').order).toBe(0)
        expect(emptyDraft('personal', 0).order).toBe(0)
        expect(emptyDraft('personal', 5).order).toBe(5)
    })
})

describe('record <-> draft round-trip', () => {
    it('preserves all fields', () => {
        const record = baseRecord({
            trigger_config: { cron: '0 * * * *' },
            actions: [
                { ref: 'core:notify', params: { title: 'hi', urgent: true, count: 3 } },
                { ref: 'cat:set-folder', params: { folder: 'folder123456789' } },
            ],
            stop_processing: true,
            order: 5,
        })

        const draft = recordToDraft(record)
        // recordToDraft assigns each loaded action a builder-local uid (see
        // 'recordToDraft assigns uids to loaded actions' below) — asserted
        // separately since the uid values themselves are generated, not fixed.
        expect(draft.actions[0].uid).toBeTruthy()
        expect(draft.actions[1].uid).toBeTruthy()
        expect(draft).toEqual<RuleDraft>({
            id: record.id,
            name: record.name,
            scope: record.scope,
            trigger: record.trigger,
            triggerConfig: { cron: '0 * * * *' },
            conditions: { match: 'all', groups: [] },
            actions: [
                {
                    uid: draft.actions[0].uid,
                    ref: 'core:notify',
                    params: { title: 'hi', urgent: true, count: 3 },
                },
                {
                    uid: draft.actions[1].uid,
                    ref: 'cat:set-folder',
                    params: { folder: 'folder123456789' },
                },
            ],
            enabled: record.enabled,
            stopProcessing: true,
            order: 5,
        })

        const fields = draftToRecord(draft)
        expect(fields).toEqual({
            name: record.name,
            scope: record.scope,
            trigger: record.trigger,
            trigger_config: { cron: '0 * * * *' },
            conditions: { match: 'all', groups: [] },
            actions: [
                { ref: 'core:notify', params: { title: 'hi', urgent: true, count: 3 } },
                { ref: 'cat:set-folder', params: { folder: 'folder123456789' } },
            ],
            enabled: record.enabled,
            stop_processing: true,
            order: 5,
        })
        expect(JSON.stringify(fields.actions)).not.toContain('uid')
    })

    it('draftToRecord omits id/owner/created/updated', () => {
        const draft = recordToDraft(baseRecord())
        const fields = draftToRecord(draft)
        expect(fields).not.toHaveProperty('id')
        expect(fields).not.toHaveProperty('owner')
        expect(fields).not.toHaveProperty('created')
        expect(fields).not.toHaveProperty('updated')
    })
})

describe('draftToRecord strips builder-local uids', () => {
    it('serializes conditions without uid, preserving the semantic content', () => {
        let conditions = addCondition(addGroup(emptyDraft('personal').conditions), 0)
        conditions = updateCondition(conditions, 0, 0, {
            field: 'subject',
            op: 'contains',
            value: 'invoice',
        })
        // Sanity: the draft-side AST really does carry uids before serializing.
        expect(conditions.groups[0].uid).toBeTruthy()
        expect(conditions.groups[0].conditions[0].uid).toBeTruthy()

        const draft: RuleDraft = {
            name: 'My rule',
            scope: 'personal',
            trigger: 'cat:item-created',
            triggerConfig: {},
            conditions,
            actions: [{ uid: 'draft-local-uid', ref: 'core:notify', params: { title: 'hi' } }],
            enabled: true,
            stopProcessing: false,
            order: 0,
        }

        const fields = draftToRecord(draft)
        expect(fields.conditions).toEqual({
            match: 'all',
            groups: [
                {
                    match: 'all',
                    conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
                },
            ],
        })
        expect(JSON.stringify(fields.conditions)).not.toContain('uid')
    })

    it('serializes actions without uid, preserving the semantic content', () => {
        const draft: RuleDraft = {
            name: 'My rule',
            scope: 'personal',
            trigger: 'cat:item-created',
            triggerConfig: {},
            conditions: { match: 'all', groups: [] },
            actions: [{ uid: 'draft-local-uid', ref: 'core:notify', params: { title: 'hi' } }],
            enabled: true,
            stopProcessing: false,
            order: 0,
        }

        const fields = draftToRecord(draft)
        expect(fields.actions).toEqual([{ ref: 'core:notify', params: { title: 'hi' } }])
        expect(JSON.stringify(fields.actions)).not.toContain('uid')
    })

    it('serializes an empty actions list as [] (ruleActionsSchema.min(1) would otherwise reject it)', () => {
        const draft: RuleDraft = {
            name: 'My rule',
            scope: 'personal',
            trigger: 'core:manual',
            triggerConfig: {},
            conditions: { match: 'all', groups: [] },
            actions: [],
            enabled: true,
            stopProcessing: false,
            order: 0,
        }

        expect(draftToRecord(draft).actions).toEqual([])
    })
})

describe('recordToDraft assigns uids to loaded conditions', () => {
    it('gives every group/condition a uid even though the stored record has none', () => {
        const record = baseRecord({
            conditions: {
                match: 'all',
                groups: [
                    {
                        match: 'all',
                        conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
                    },
                ],
            },
        })
        const draft = recordToDraft(record)
        expect(draft.conditions.groups[0].uid).toBeTruthy()
        expect(draft.conditions.groups[0].conditions[0].uid).toBeTruthy()
        expect(draft.conditions.groups[0].conditions[0]).toMatchObject({
            field: 'subject',
            op: 'contains',
            value: 'x',
        })
    })
})

describe('recordToDraft assigns uids to loaded actions', () => {
    it('gives every action a uid even though the stored record has none, and each is distinct', () => {
        const record = baseRecord({
            actions: [
                { ref: 'core:notify', params: { title: 'hi' } },
                { ref: 'cat:set-folder', params: { folder: 'folder123456789' } },
            ],
        })
        const draft = recordToDraft(record)
        expect(draft.actions[0].uid).toBeTruthy()
        expect(draft.actions[1].uid).toBeTruthy()
        expect(draft.actions[0].uid).not.toBe(draft.actions[1].uid)
        expect(draft.actions[0]).toMatchObject({ ref: 'core:notify', params: { title: 'hi' } })
    })
})

describe('recordToDraft tolerance', () => {
    it('degrades malformed conditions JSON to an empty AST, no throw', () => {
        const record = baseRecord({ conditions: 'not-an-ast' as unknown as Rules['conditions'] })
        expect(() => recordToDraft(record)).not.toThrow()
        const draft = recordToDraft(record)
        expect(draft.conditions).toEqual({ match: 'all', groups: [] })
    })

    it('degrades malformed actions JSON to an empty actions list, no throw', () => {
        const record = baseRecord({ actions: { not: 'an array' } as unknown as Rules['actions'] })
        expect(() => recordToDraft(record)).not.toThrow()
        const draft = recordToDraft(record)
        expect(draft.actions).toEqual([])
    })

    it('degrades a null trigger_config to an empty object, no throw', () => {
        const record = baseRecord({ trigger_config: null as unknown as Rules['trigger_config'] })
        expect(() => recordToDraft(record)).not.toThrow()
        const draft = recordToDraft(record)
        expect(draft.triggerConfig).toEqual({})
    })
})
