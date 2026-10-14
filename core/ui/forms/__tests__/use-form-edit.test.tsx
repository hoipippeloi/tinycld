// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { useFormEdit } from '../use-form-edit'

const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const bug = {
    id: 'f2',
    host: host.key,
    name: 'Bug',
    slug: 'bug',
    is_default: false,
    archived: false,
    order: 1,
    definition: definitionSchema.parse({
        ...defaultDefinitionFor(widgetHost),
        fields: [
            ...defaultDefinitionFor(widgetHost).fields,
            {
                key: 'severity',
                kind: 'select',
                page: 'main',
                label: 'Severity',
                options: [{ value: 'low', label: 'Low' }],
            },
            { key: 'count', kind: 'number', page: 'main', label: 'Count' },
        ],
    }),
}

vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormsOfHost: () => ({ forms: [bug], defaultForm: bug, isReady: true }),
}))

const ctx = { today: '2026-01-10', userId: 'me' }
const record = {
    id: 'w1',
    name: 'N',
    due: null,
    notes: '',
    owner: '',
    form: 'f2',
    fields: { severity: 'low', count: 2 },
}

describe('useFormEdit', () => {
    it('patch returns the dirty keys, split, over the stored json column', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        const split = await result.current.patch()
        expect(split).toEqual({ columns: {}, fields: { severity: 'low', count: 3 }, rows: {} })
    })
    it('keeps a key the form does not declare in the returned fields', async () => {
        const withOrphan = { ...record, fields: { severity: 'low', count: 2, legacy: 'kept' } }
        const { result } = renderHook(() => useFormEdit(host, withOrphan, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        const split = await result.current.patch()
        expect(split?.fields).toEqual({ severity: 'low', count: 3, legacy: 'kept' })
    })
    it('a second patch returns only its own change', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        await act(async () => {
            await result.current.patch()
        })
        act(() => result.current.form.setValue('name', 'M', { shouldDirty: true }))
        let second: Awaited<ReturnType<typeof result.current.patch>> = null
        await act(async () => {
            second = await result.current.patch()
        })
        expect(second).toEqual({ columns: { name: 'M' }, fields: {}, rows: {} })
    })
    it('shows a remote change to a key it already patched', async () => {
        const { result, rerender } = renderHook(({ rec }) => useFormEdit(host, rec, ctx), {
            initialProps: { rec: record },
        })
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        await act(async () => {
            await result.current.patch()
        })
        rerender({ rec: { ...record, fields: { severity: 'low', count: 5 } } })
        await waitFor(() => expect(result.current.form.getValues('count')).toBe(5))
    })
    it('patch returns empty buckets when nothing changed', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        const split = await result.current.patch()
        expect(split).toEqual({ columns: {}, fields: {}, rows: {} })
    })
})
