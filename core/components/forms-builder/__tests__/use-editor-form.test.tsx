// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField, removeField } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { draftPath, fromDraft, toDraft, useEditorForm } from '../use-editor-form'

const plain = {
    id: 'f1',
    host: 'gizmos:widget',
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: defaultDefinitionFor(widgetHost),
}
const save = vi.fn(async () => {})
const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const admin = {
    host,
    forms: [plain],
    defaultForm: plain,
    isReady: true,
    saveDefinition: { mutateAsync: save, isPending: false },
}
vi.mock('../../../lib/forms/use-form-admin', async importOriginal => ({
    ...(await importOriginal<object>()),
    useFormAdmin: () => admin,
}))
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: plain, isReady: true }),
    useFormsOfHost: () => ({ forms: [plain], defaultForm: plain, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => host }))

beforeEach(() => save.mockClear())

describe('useEditorForm', () => {
    it('loads the row into the form and applies draft operations', () => {
        const { result } = renderHook(() => useEditorForm('f1'))
        expect(result.current.isReady).toBe(true)
        expect(result.current.form.getValues('pages')).toEqual([{ key: 'main', title: 'Widget' }])
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [
                    ...def.fields,
                    newCustomField('text', 'Nick', 'main', new Set(def.fields.map(f => f.key))),
                ],
            }))
        )
        expect(result.current.form.getValues('fields').at(-1)?.key).toBe('nick')
        expect(result.current.fields.fields.at(-1)).toMatchObject({ key: 'nick' })
        expect(result.current.isDirty).toBe(true)
    })
    it('saves a valid definition and returns true', async () => {
        const { result } = renderHook(() => useEditorForm('f1'))
        let ok = false
        await act(async () => {
            ok = await result.current.save()
        })
        expect(ok).toBe(true)
        expect(save).toHaveBeenCalledWith({
            id: 'f1',
            definition: expect.objectContaining({ version: 1 }),
        })
    })
    it('maps a server path error onto the form and returns false', async () => {
        save.mockRejectedValueOnce({
            response: { data: { 'definition.fields.0.label': { message: 'bad label' } } },
        })
        const { result } = renderHook(() => useEditorForm('f1'))
        let ok = true
        await act(async () => {
            ok = await result.current.save()
        })
        expect(ok).toBe(false)
        expect(result.current.form.getFieldState('fields.0.label').error?.message).toBe('bad label')
    })
    it('shows a server error on a file field accept list on its text input', async () => {
        save.mockRejectedValueOnce({
            response: { data: { 'definition.fields.6.accept.0': { message: 'bad type' } } },
        })
        const { result } = renderHook(() => useEditorForm('f1'))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('file', 'Doc', 'main', new Set())],
            }))
        )
        await act(async () => {
            await result.current.save()
        })
        expect(result.current.form.getFieldState('fields.6.acceptText').error?.message).toBe(
            'bad type'
        )
    })
    it('refuses to save a definition that fails host validation', async () => {
        const { result } = renderHook(() => useEditorForm('f1'))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: def.fields.map(f => (f.key === 'name' ? { ...f, hidden: true } : f)),
            }))
        )
        let ok = true
        await act(async () => {
            ok = await result.current.save()
        })
        expect(ok).toBe(false)
        expect(result.current.form.getFieldState('fields.0.hidden').error?.message).toMatch(
            /cannot be hidden/
        )
        expect(save).not.toHaveBeenCalled()
    })
    it('applyRemoval reports what was dropped as a notice', () => {
        const { result } = renderHook(() => useEditorForm('f1'))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('text', 'Nick', 'main', new Set())],
                defaults: { nick: 'x' },
            }))
        )
        act(() => {
            result.current.applyRemoval(def => removeField(def, 'nick'))
        })
        expect(result.current.notice).toMatch(/default/)
        expect(result.current.form.getValues('fields').some(f => f.key === 'nick')).toBe(false)
    })
})

describe('toDraft / fromDraft', () => {
    const withFile = (accept: string[]) => {
        const def = defaultDefinitionFor(widgetHost)
        return {
            ...def,
            fields: [
                ...def.fields,
                { ...newCustomField('file', 'Doc', 'main', new Set()), accept },
            ],
        }
    }
    it('round-trips file accept', () => {
        const draft = toDraft(withFile(['image/*', 'application/pdf']))
        expect(draft.fields.at(-1)).toMatchObject({ acceptText: 'image/*, application/pdf' })
        const back = fromDraft(draft).fields.at(-1)
        expect(back).toMatchObject({ accept: ['image/*', 'application/pdf'] })
        expect(back).not.toHaveProperty('acceptText')
    })
    it('splits, trims and drops empties', () => {
        const draft = toDraft(withFile([]))
        const file = draft.fields.at(-1)
        if (file) file.acceptText = 'image/*, , x'
        expect(fromDraft(draft).fields.at(-1)).toMatchObject({ accept: ['image/*', 'x'] })
    })
    it('drops optional props a cleared input left as an empty string', () => {
        const def = defaultDefinitionFor(widgetHost)
        const nick = { ...newCustomField('number', 'Nick', 'main', new Set()), min: 1 }
        const draft = toDraft({ ...def, fields: [...def.fields, nick] })
        const cleared = { ...draft, fields: draft.fields.map(f => ({ ...f, description: '' })) }
        const out = fromDraft(cleared)
        expect(out.fields.at(-1)).toMatchObject({ min: 1 })
        expect(out.fields.some(f => 'description' in f)).toBe(false)
    })
})

describe('draftPath', () => {
    it('points accept errors at the acceptText input', () => {
        expect(draftPath('fields.3.accept.0')).toBe('fields.3.acceptText')
        expect(draftPath('fields.3.accept')).toBe('fields.3.acceptText')
        expect(draftPath('fields.3.label')).toBe('fields.3.label')
    })
})
