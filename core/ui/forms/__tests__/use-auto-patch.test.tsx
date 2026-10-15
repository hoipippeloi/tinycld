// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormValues } from '../../../lib/forms/logic'
import type { SplitValues } from '../../../lib/forms/values'
import { useAutoPatch } from '../use-auto-patch'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setUp(patchResult: SplitValues | null) {
    const save = vi.fn(async () => {})
    const markSaved = vi.fn()
    const patch = vi.fn(async (): Promise<SplitValues | null> => patchResult)
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
        const { hook, save, markSaved, patch } = setUp(split)
        act(() => hook.result.current.setValue('name', 'b', { shouldDirty: true }))
        act(() => hook.result.current.setValue('sev', 'high', { shouldDirty: true }))
        expect(patch).not.toHaveBeenCalled()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300)
        })
        expect(patch).toHaveBeenCalledTimes(1)
        expect(save).toHaveBeenCalledWith(split)
        expect(markSaved).toHaveBeenCalledWith(['name', 'sev'])
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
            async (): Promise<SplitValues | null> => ({
                columns: { name: 'x' },
                fields: {},
                rows: {},
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
})
