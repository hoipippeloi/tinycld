// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { log } from '@tinycld/core/lib/logger'
import { useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import type { FormValues } from '../../../lib/forms/logic'
import type { SplitValues } from '../../../lib/forms/values'
import { useAutoPatch } from '../use-auto-patch'
import type { PatchResult } from '../use-form-edit'
import { useFormEdit } from '../use-form-edit'

vi.mock('@tinycld/core/lib/logger', () => ({
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(log.error).mockClear()
})
afterEach(() => vi.useRealTimers())

function setUp(patchResult: PatchResult | null) {
    const save = vi.fn(async () => {})
    const markSaved = vi.fn()
    const patch = vi.fn(async (): Promise<PatchResult | null> => patchResult)
    const hook = renderHook(() => {
        const form = useForm<FormValues>({ defaultValues: { name: 'a', sev: 'low' } })
        useAutoPatch({ form, patch, markSaved }, save, 300)
        return form
    })
    return { hook, save, markSaved, patch }
}

describe('useAutoPatch', () => {
    it('patches once after the last change settles and marks the written keys saved', async () => {
        const split = { columns: { name: 'b' }, fields: { sev: 'high' }, rows: {} }
        const written = { name: 'b', sev: 'high' }
        const { hook, save, markSaved, patch } = setUp({ ...split, written })
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        act(() => hook.result.current.setValue('sev', 'high', { shouldDirty: true }))
        expect(patch).not.toHaveBeenCalled()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(patch).toHaveBeenCalledTimes(1)
        expect(save).toHaveBeenCalledWith(split)
        expect(markSaved).toHaveBeenCalledWith(written)
    })

    it('does nothing when the patch finds no valid change', async () => {
        const { hook, save, markSaved } = setUp(null)
        act(() => hook.result.current.setValue('name', '', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(save).not.toHaveBeenCalled()
        expect(markSaved).not.toHaveBeenCalled()
    })

    it('runs one more patch after a save when a change landed during it', async () => {
        let release = () => {}
        const save = vi.fn(
            () =>
                new Promise<void>(resolve => {
                    release = resolve
                })
        )
        const patch = vi.fn(
            async (): Promise<PatchResult | null> => ({
                columns: { name: 'x' },
                fields: {},
                rows: {},
                written: { name: 'x' },
            })
        )
        const markSaved = vi.fn()
        const hook = renderHook(() => {
            const form = useForm<FormValues>({ defaultValues: { name: 'a' } })
            useAutoPatch({ form, patch, markSaved }, save, 300)
            return form
        })
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(save).toHaveBeenCalledTimes(1)
        act(() => hook.result.current.setValue('name', 'c', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(patch).toHaveBeenCalledTimes(1) // waits for the save in flight
        await act(async () => {
            release()
            await Promise.resolve()
        })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })
        expect(patch).toHaveBeenCalledTimes(2)
    })

    it('does not patch on a reset that only mirrors the saved row', async () => {
        const { hook, patch } = setUp(null)
        act(() => hook.result.current.reset({ name: 'a', sev: 'low' }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(patch).not.toHaveBeenCalled()
    })

    it('logs a failed save once and leaves the form dirty', async () => {
        const failure = new Error('write refused')
        const save = vi.fn(async () => {
            throw failure
        })
        const markSaved = vi.fn()
        const patch = vi.fn(
            async (): Promise<PatchResult | null> => ({
                columns: { name: 'b' },
                fields: {},
                rows: {},
                written: { name: 'b' },
            })
        )
        const hook = renderHook(() => {
            const form = useForm<FormValues>({ defaultValues: { name: 'a' } })
            useAutoPatch({ form, patch, markSaved }, save, 300)
            return form
        })
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(log.error).toHaveBeenCalledTimes(1)
        expect(log.error).toHaveBeenCalledWith('forms.auto-patch', failure)
        expect(markSaved).not.toHaveBeenCalled()
        expect(hook.result.current.getFieldState('name').isDirty).toBe(true)
    })

    it('flushes a pending change when the screen unmounts', async () => {
        const split = { columns: { name: 'b' }, fields: {}, rows: {} }
        const { hook, save } = setUp({ ...split, written: { name: 'b' } })
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        hook.unmount()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })
        expect(save).toHaveBeenCalledWith(split)
    })
})

const gizmoForm = {
    id: 'f2',
    host: widgetHost.key,
    name: 'Bug',
    slug: 'bug',
    is_default: true,
    archived: false,
    order: 0,
    definition: definitionSchema.parse({
        ...defaultDefinitionFor(widgetHost),
        fields: [
            ...defaultDefinitionFor(widgetHost).fields,
            { key: 'severity', kind: 'text', page: 'main', label: 'Severity' },
        ],
    }),
}
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormsOfHost: () => ({ forms: [gizmoForm], defaultForm: gizmoForm, isReady: true }),
}))

describe('useAutoPatch with the real useFormEdit', () => {
    const host = {
        ...widgetHost,
        pkgSlug: 'gizmos',
        pkgName: 'Gizmos',
        ui: async () => ({ components: {}, mappers: {} }),
    }
    const record = {
        id: 'w1',
        name: 'N',
        due: null,
        notes: '',
        owner: '',
        form: 'f2',
        fields: { severity: 'low' },
    }
    const ctx = { today: '2026-01-10', userId: 'me' }

    it('writes an edit typed while the previous save is in flight', async () => {
        const releases: (() => void)[] = []
        const save = vi.fn(
            (_split: SplitValues) =>
                new Promise<void>(resolve => {
                    releases.push(resolve)
                })
        )
        const hook = renderHook(() => {
            const edit = useFormEdit(host, record, ctx)
            useAutoPatch(edit, save, 300)
            return edit.form
        })
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        act(() => hook.result.current.setValue('severity', 'high', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(save).toHaveBeenCalledTimes(1)
        act(() => hook.result.current.setValue('name', 'c', { shouldDirty: true }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        await act(async () => {
            releases[0]()
            await vi.advanceTimersByTimeAsync(0)
        })
        expect(save).toHaveBeenCalledTimes(2)
        expect(save.mock.calls[1][0]).toMatchObject({ columns: { name: 'c' } })
        expect(hook.result.current.getValues('name')).toBe('c')
    })
})
