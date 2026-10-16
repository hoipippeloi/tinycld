// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { moveField, newCustomField, removeField, removeRule } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { log } from '../../../lib/logger'
import {
    dateIssues,
    draftPath,
    fromDraft,
    SAVE_FAILED,
    toDraft,
    useEditorForm,
} from '../use-editor-form'

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
        const { result } = renderHook(() => useEditorForm(plain, host))
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
        const { result } = renderHook(() => useEditorForm(plain, host))
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
        const { result } = renderHook(() => useEditorForm(plain, host))
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
        const { result } = renderHook(() => useEditorForm(plain, host))
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
    describe('typed defaults', () => {
        const withCount = (defaults: Record<string, string>) =>
            act(() =>
                result().apply(def => ({
                    ...def,
                    fields: [...def.fields, newCustomField('number', 'Count', 'main', new Set())],
                    defaults,
                }))
            )
        let hook: ReturnType<typeof renderHook<ReturnType<typeof useEditorForm>, unknown>>
        const result = () => hook.result.current
        const saveIt = async () => {
            let ok = false
            await act(async () => {
                ok = await result().save()
            })
            return ok
        }
        beforeEach(() => {
            hook = renderHook(() => useEditorForm(plain, host))
        })
        it('saves a number default typed as text as a number', async () => {
            withCount({ count: '5' })
            expect(await saveIt()).toBe(true)
            expect(save).toHaveBeenCalledWith({
                id: 'f1',
                definition: expect.objectContaining({ defaults: { count: 5 } }),
            })
        })
        it('refuses a number default that is not a number', async () => {
            withCount({ count: 'abc' })
            expect(await saveIt()).toBe(false)
            expect(save).not.toHaveBeenCalled()
            expect(result().form.getFieldState('defaults.count').error?.message).toBe(
                'Count default must be a number'
            )
        })
        it('drops an empty default', async () => {
            withCount({ count: '' })
            expect(await saveIt()).toBe(true)
            expect(save).toHaveBeenCalledWith({
                id: 'f1',
                definition: expect.objectContaining({ defaults: {} }),
            })
        })
    })
    it('refuses to save a definition that fails host validation', async () => {
        const { result } = renderHook(() => useEditorForm(plain, host))
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
        const { result } = renderHook(() => useEditorForm(plain, host))
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

describe('useEditorForm reads the row once', () => {
    const nick = newCustomField('text', 'Nick', 'main', new Set())
    const withNick = {
        ...plain,
        definition: { ...plain.definition, fields: [...plain.definition.fields, nick] },
    }
    it('keeps the draft and the server error through an optimistic write and its rollback', async () => {
        const hook = renderHook(({ row }) => useEditorForm(row, host), {
            initialProps: { row: withNick },
        })
        act(() => {
            hook.result.current.applyRemoval(def => removeField(def, 'nick'))
        })
        const draft = hook.result.current.form.getValues()
        save.mockImplementationOnce(async () => {
            // pbtsdb applies the write to the live row, then rolls it back when the server refuses.
            hook.rerender({ row: { ...withNick, definition: { ...plain.definition } } })
            hook.rerender({ row: withNick })
            throw { response: { data: { 'definition.fields.0.label': { message: 'bad label' } } } }
        })
        let ok = true
        await act(async () => {
            ok = await hook.result.current.save()
        })
        expect(ok).toBe(false)
        expect(hook.result.current.form.getValues()).toEqual(draft)
        expect(hook.result.current.form.getValues('fields').some(f => f.key === 'nick')).toBe(false)
        expect(hook.result.current.form.getFieldState('fields.0.label').error?.message).toBe(
            'bad label'
        )
        expect(hook.result.current.isChangedElsewhere).toBe(false)
    })
    it('reports a change made elsewhere and reloads it on request', () => {
        const hook = renderHook(({ row }) => useEditorForm(row, host), {
            initialProps: { row: plain },
        })
        expect(hook.result.current.isChangedElsewhere).toBe(false)
        hook.rerender({ row: withNick })
        expect(hook.result.current.isChangedElsewhere).toBe(true)
        expect(hook.result.current.form.getValues('fields').some(f => f.key === 'nick')).toBe(false)
        act(() => hook.result.current.reload())
        expect(hook.result.current.isChangedElsewhere).toBe(false)
        expect(hook.result.current.form.getValues('fields').some(f => f.key === 'nick')).toBe(true)
        expect(hook.result.current.isDirty).toBe(false)
    })
    it('is clean after a save and does not report its own save as a change elsewhere', async () => {
        const hook = renderHook(({ row }) => useEditorForm(row, host), {
            initialProps: { row: plain },
        })
        act(() => hook.result.current.apply(def => ({ ...def, fields: [...def.fields, nick] })))
        expect(hook.result.current.isDirty).toBe(true)
        await act(async () => {
            await hook.result.current.save()
        })
        expect(hook.result.current.isDirty).toBe(false)
        hook.rerender({ row: withNick })
        expect(hook.result.current.isChangedElsewhere).toBe(false)
    })
})

describe('useEditorForm errors', () => {
    it('puts a server error on a key that is not part of the definition on the form', async () => {
        save.mockRejectedValueOnce({ response: { data: { name: { message: 'name taken' } } } })
        const { result } = renderHook(() => useEditorForm(plain, host))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('text', 'Nick', 'main', new Set())],
            }))
        )
        await act(async () => {
            await result.current.save()
        })
        expect(result.current.form.formState.errors.root?.message).toBe('name taken')
    })
    it('keeps a field error on its field when a move shifts the field indexes', async () => {
        save.mockRejectedValueOnce({
            response: { data: { 'definition.fields.2.label': { message: 'bad label' } } },
        })
        const { result } = renderHook(() => useEditorForm(plain, host))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('text', 'Nick', 'main', new Set())],
            }))
        )
        await act(async () => {
            await result.current.save()
        })
        expect(result.current.form.getValues('fields.2.key')).toBe('due')
        act(() => result.current.apply(def => moveField(def, 'due', 'main', 0)))
        expect(result.current.form.getValues('fields.0.key')).toBe('due')
        expect(result.current.form.getFieldState('fields.0.label').error?.message).toBe('bad label')
        expect(result.current.form.getFieldState('fields.2.label').error).toBeUndefined()
    })
    it('clears the selection when the selected field is removed', () => {
        const { result } = renderHook(() => useEditorForm(plain, host))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('text', 'Nick', 'main', new Set())],
            }))
        )
        act(() => result.current.select('nick'))
        act(() => {
            result.current.applyRemoval(def => removeField(def, 'nick'))
        })
        expect(result.current.selectedKey).toBeNull()
    })
    it('keeps the selection when another field is removed', () => {
        const { result } = renderHook(() => useEditorForm(plain, host))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [...def.fields, newCustomField('text', 'Nick', 'main', new Set())],
            }))
        )
        act(() => result.current.select('due'))
        act(() => {
            result.current.applyRemoval(def => removeField(def, 'nick'))
        })
        expect(result.current.selectedKey).toBe('due')
    })
    it('refuses to save a field with no label and shows it on the label', async () => {
        const { result } = renderHook(() => useEditorForm(plain, host))
        act(() =>
            result.current.apply(def => ({
                ...def,
                fields: [
                    ...def.fields,
                    { ...newCustomField('file', 'Doc', 'main', new Set()), label: '' },
                ],
            }))
        )
        await act(async () => {
            await result.current.save()
        })
        expect(save).not.toHaveBeenCalled()
        expect(result.current.form.getFieldState('fields.6.label').error).toBeTruthy()
    })
})

describe('useEditorForm saving and rules', () => {
    const rule = (key: string) => ({
        key,
        match: 'all' as const,
        when: [{ field: 'due', op: 'before' as const, value: '2026-01-31' }],
        actions: [{ action: 'set_value' as const, field: 'due', value: '2026-01-01' }],
    })
    const twoRules = {
        ...plain,
        definition: { ...plain.definition, rules: [rule('a'), rule('b'), rule('c')] },
    }

    it('shows a root message and does not throw when the save itself rejects', async () => {
        const logError = vi.spyOn(log, 'error').mockImplementation(() => {})
        const { result } = renderHook(() => {
            const editor = useEditorForm(plain, host)
            // Reading the errors during render subscribes the hook to them.
            return { editor, root: editor.form.formState.errors.root?.message }
        })
        const error = new Error('boom')
        vi.spyOn(result.current.editor.form, 'handleSubmit').mockReturnValue(() =>
            Promise.reject(error)
        )
        await act(async () => {
            await result.current.editor.saveSafely()
        })
        expect(result.current.root).toBe(SAVE_FAILED)
        expect(logError).toHaveBeenCalledWith('forms.builder.save', error, { formId: 'f1' })
        logError.mockRestore()
    })

    it('clears rule errors when a rule is removed, so none sit on the wrong card', () => {
        const { result } = renderHook(() => useEditorForm(twoRules, host))
        act(() => {
            result.current.form.setError('rules.1.when', { type: 'manual', message: 'bad' })
        })
        expect(result.current.form.getFieldState('rules.1.when').error).toBeTruthy()
        act(() => result.current.apply(def => removeRule(def, 'a')))
        expect(result.current.form.getValues('rules')).toHaveLength(2)
        expect(result.current.form.getFieldState('rules.0').error).toBeUndefined()
        expect(result.current.form.getFieldState('rules.0.when').error).toBeUndefined()
        expect(result.current.form.getFieldState('rules.1.when').error).toBeUndefined()
    })

    it('keeps rule errors when the rules did not change', () => {
        const { result } = renderHook(() => useEditorForm(twoRules, host))
        act(() => {
            result.current.form.setError('rules.1.when', { type: 'manual', message: 'bad' })
        })
        act(() => result.current.apply(def => ({ ...def, defaults: { ...def.defaults } })))
        expect(result.current.form.getFieldState('rules.1.when').error).toBeTruthy()
    })
})

describe('dateIssues', () => {
    const def = (patch: object) => ({ ...plain.definition, ...patch })
    it('flags a date default, set_value and before/after value that is not YYYY-MM-DD', () => {
        const issues = dateIssues(
            def({
                defaults: { due: 'soon' },
                rules: [
                    {
                        key: 'r',
                        match: 'all' as const,
                        when: [
                            { field: 'due', op: 'before' as const, value: '2026-13' },
                            { field: 'due', op: 'after' as const, value: '2026-01-31' },
                        ],
                        actions: [{ action: 'set_value' as const, field: 'due', value: 'later' }],
                    },
                ],
            }),
            widgetHost
        )
        expect(issues.map(i => i.path.join('.'))).toEqual([
            'defaults.due',
            'rules.0.when.0.value',
            'rules.0.actions.0.value',
        ])
        expect(issues[0].message).toBe('Use YYYY-MM-DD')
    })
    it('accepts a day, a day and a time, and the date expressions', () => {
        const issues = dateIssues(
            def({
                defaults: { due: '2026-01-31T09:30' },
                rules: [
                    {
                        key: 'r',
                        match: 'all' as const,
                        when: [{ field: 'due', op: 'before' as const, value: '2026-01-31' }],
                        actions: [
                            { action: 'set_value' as const, field: 'due', value: { today: [] } },
                        ],
                    },
                ],
            }),
            widgetHost
        )
        expect(issues).toEqual([])
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
        const back = fromDraft(draft, widgetHost).fields.at(-1)
        expect(back).toMatchObject({ accept: ['image/*', 'application/pdf'] })
        expect(back).not.toHaveProperty('acceptText')
    })
    it('splits, trims and drops empties', () => {
        const draft = toDraft(withFile([]))
        const file = draft.fields.at(-1)
        if (file) file.acceptText = 'image/*, , x'
        expect(fromDraft(draft, widgetHost).fields.at(-1)).toMatchObject({
            accept: ['image/*', 'x'],
        })
    })
    it('drops optional props a cleared input left as an empty string', () => {
        const def = defaultDefinitionFor(widgetHost)
        const nick = { ...newCustomField('number', 'Nick', 'main', new Set()), min: 1 }
        const draft = toDraft({ ...def, fields: [...def.fields, nick] })
        const cleared = { ...draft, fields: draft.fields.map(f => ({ ...f, description: '' })) }
        const out = fromDraft(cleared, widgetHost)
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
