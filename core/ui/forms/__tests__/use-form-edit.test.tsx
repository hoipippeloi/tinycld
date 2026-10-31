// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor, hostDefSchema } from '../../../lib/forms/host'
import type { HostSchemas } from '../../../lib/forms/values'
import { useFormEdit } from '../use-form-edit'

const host = {
    ...widgetHost,
    pkgSlug: 'gizmos',
    pkgName: 'Gizmos',
    ui: async () => ({ components: {} }),
}
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
            { key: 'count', kind: 'number', page: 'main', label: 'Count', max: 10 },
        ],
    }),
}

const gadgetHostDef = hostDefSchema.parse({
    key: 'gizmos:gadget',
    label: 'Gadget',
    collection: 'gizmos_gadgets',
    formColumn: 'form',
    fieldsColumn: 'fields',
    columns: ['title', 'amount', 'label'],
    builtin: [
        { key: 'title', label: 'Title', kind: 'text', storage: 'column', required: true },
        {
            key: 'amount',
            label: 'Amount',
            kind: 'custom',
            storage: 'column',
            component: 'AmountField',
        },
        { key: 'label', label: 'Label', kind: 'text', storage: 'column', component: 'AmountField' },
    ],
})
const gadget = {
    ...gadgetHostDef,
    pkgSlug: 'gizmos',
    pkgName: 'Gizmos',
    ui: async () => ({ components: {} }),
}
const gadgetForm = {
    id: 'g-form',
    host: gadget.key,
    name: 'Gadget',
    slug: 'gadget',
    is_default: true,
    archived: false,
    order: 0,
    definition: defaultDefinitionFor(gadgetHostDef),
}

const loading = vi.hoisted(() => ({ value: false }))

vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormsOfHost: (hostKey: string) => {
        if (loading.value) return { forms: [], defaultForm: undefined, isReady: false }
        if (hostKey === gadgetForm.host)
            return { forms: [gadgetForm], defaultForm: gadgetForm, isReady: true }
        return { forms: [bug], defaultForm: bug, isReady: true }
    },
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

const strictRecord = { ...record, fields: { severity: 'low', count: 50 } }

describe('useFormEdit', () => {
    it('edits on the default form and reports the id when the named form is missing', () => {
        const { result } = renderHook(() => useFormEdit(host, { ...record, form: 'missing' }, ctx))
        expect(result.current.definition).toEqual(bug.definition)
        expect(result.current.fallback).toBe('missing')
    })
    it('reports no fallback while the forms are still loading', () => {
        loading.value = true
        try {
            const { result } = renderHook(() => useFormEdit(host, record, ctx))
            expect(result.current.fallback).toBeUndefined()
        } finally {
            loading.value = false
        }
    })
    it('reports no fallback when the named form exists or none is named', () => {
        const named = renderHook(() => useFormEdit(host, record, ctx))
        const unnamed = renderHook(() => useFormEdit(host, { ...record, form: '' }, ctx))
        expect(named.result.current.fallback).toBeUndefined()
        expect(unnamed.result.current.fallback).toBeUndefined()
    })
    it('patch returns the dirty keys, split, over the stored json column', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        const split = await result.current.patch()
        expect(split).toEqual({
            columns: {},
            fields: { severity: 'low', count: 3 },
            rows: {},
            tables: {},
            tableWrites: {},
            written: { count: 3 },
        })
    })
    it('keeps a key the form does not declare in the returned fields', async () => {
        const withOrphan = { ...record, fields: { severity: 'low', count: 2, legacy: 'kept' } }
        const { result } = renderHook(() => useFormEdit(host, withOrphan, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        const split = await result.current.patch()
        expect(split?.fields).toEqual({ severity: 'low', count: 3, legacy: 'kept' })
    })
    it('a second patch resends keys until the host marks them saved', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        await act(async () => {
            await result.current.patch()
        })
        act(() => result.current.form.setValue('name', 'M', { shouldDirty: true }))
        let second: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            second = await result.current.patch()
        })
        expect(second?.fields).toEqual({ severity: 'low', count: 3 })
        expect(second?.columns).toEqual({ name: 'M' })
        act(() => result.current.markSaved({ count: 3, name: 'M' }))
        act(() => result.current.form.setValue('name', 'P', { shouldDirty: true }))
        let third: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            third = await result.current.patch()
        })
        expect(third).toEqual({
            columns: { name: 'P' },
            fields: {},
            rows: {},
            tables: {},
            tableWrites: {},
            written: { name: 'P' },
        })
    })
    it('does not validate untouched fields', async () => {
        const { result } = renderHook(() => useFormEdit(host, strictRecord, ctx))
        act(() => result.current.form.setValue('name', 'N2', { shouldDirty: true }))
        let out: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            out = await result.current.patch()
        })
        expect(out).toEqual({
            columns: { name: 'N2' },
            fields: {},
            rows: {},
            tables: {},
            tableWrites: {},
            written: { name: 'N2' },
        })
    })
    it('returns null and sets the error when a dirty key is invalid', async () => {
        const { result } = renderHook(() => useFormEdit(host, strictRecord, ctx))
        act(() => result.current.form.setValue('count', 99, { shouldDirty: true }))
        let out: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            out = await result.current.patch()
        })
        expect(out).toBeNull()
        expect(result.current.form.getFieldState('count').error).toBeDefined()
    })
    it('shows a remote change to a key the host marked saved', async () => {
        const { result, rerender } = renderHook(({ rec }) => useFormEdit(host, rec, ctx), {
            initialProps: { rec: record },
        })
        act(() => result.current.form.setValue('count', 3, { shouldDirty: true }))
        await act(async () => {
            await result.current.patch()
        })
        act(() => result.current.markSaved({ count: 3 }))
        rerender({ rec: { ...record, fields: { severity: 'low', count: 5 } } })
        await waitFor(() => expect(result.current.form.getValues('count')).toBe(5))
    })
    it('keeps a key dirty when it changed after the written value was taken', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        act(() => result.current.form.setValue('name', 'b', { shouldDirty: true }))
        let first: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            first = await result.current.patch()
        })
        act(() => result.current.form.setValue('name', 'c', { shouldDirty: true }))
        act(() => result.current.markSaved(first?.written ?? {}))
        expect(result.current.form.getFieldState('name').isDirty).toBe(true)
        let next: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            next = await result.current.patch()
        })
        expect(next?.columns).toEqual({ name: 'c' })
    })
    it('refuses a patch with the message of the component schema', async () => {
        const schemas: HostSchemas = { AmountField: z.number().min(0, 'Use 0 or more') }
        const gadgetRecord = { id: 'g1', amount: 2 }
        const { result } = renderHook(() => useFormEdit(gadget, gadgetRecord, ctx, {}, {}, schemas))
        act(() => result.current.form.setValue('amount', -1, { shouldDirty: true }))
        let refused: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            refused = await result.current.patch()
        })
        expect(refused).toBeNull()
        expect(result.current.form.getFieldState('amount').error?.message).toBe('Use 0 or more')
        act(() => result.current.form.setValue('amount', 3, { shouldDirty: true }))
        let accepted: Awaited<ReturnType<typeof result.current.patch>> | undefined
        await act(async () => {
            accepted = await result.current.patch()
        })
        expect(accepted?.columns).toEqual({ amount: 3 })
    })
    it('patch returns empty buckets when nothing changed', async () => {
        const { result } = renderHook(() => useFormEdit(host, record, ctx))
        const split = await result.current.patch()
        expect(split).toEqual({
            columns: {},
            fields: {},
            rows: {},
            tables: {},
            written: {},
            tableWrites: {},
        })
    })
})
