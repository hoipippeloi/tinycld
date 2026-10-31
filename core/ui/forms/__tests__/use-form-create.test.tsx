// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor, hostDefSchema } from '../../../lib/forms/host'
import type { HostSchemas } from '../../../lib/forms/values'
import { useFormCreate } from '../use-form-create'

const host = {
    ...widgetHost,
    pkgSlug: 'gizmos',
    pkgName: 'Gizmos',
    ui: async () => ({ components: {} }),
}
const plain = {
    id: 'f1',
    host: host.key,
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: defaultDefinitionFor(widgetHost),
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
        ],
        defaults: { severity: 'low', due: { addDays: [{ today: [] }, 21] } },
    }),
}

const loaded = { forms: [plain, bug], defaultForm: plain, isReady: true }
const formsOfHost = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/forms/use-forms-of-host', () => ({ useFormsOfHost: formsOfHost }))

const ctx = { today: '2026-01-10', userId: 'me' }

describe('useFormCreate', () => {
    beforeEach(() => formsOfHost.mockReturnValue(loaded))
    it('seeds defaults for the chosen form and splits on submit', async () => {
        const { result } = renderHook(() => useFormCreate(host, 'f2', ctx))
        expect(result.current.form.getValues('severity')).toBe('low')
        expect(result.current.form.getValues('due')).toBe('2026-01-31')
        act(() => result.current.form.setValue('name', 'W'))
        const split = await result.current.submit()
        expect(split).toEqual({
            columns: { name: 'W', due: '2026-01-31' },
            fields: { severity: 'low' },
            rows: {},
            tables: {},
        })
    })
    it('returns null and sets errors when required fields are empty', async () => {
        const { result } = renderHook(() => useFormCreate(host, 'f2', ctx))
        const split = await result.current.submit()
        expect(split).toBeNull()
        expect(result.current.form.getFieldState('name').error).toBeTruthy()
    })
    it('switchForm keeps shared keys and re-applies defaults for the rest', () => {
        const { result } = renderHook(() => useFormCreate(host, 'f1', ctx))
        act(() => result.current.form.setValue('name', 'Keep me'))
        act(() => result.current.switchForm('f2'))
        expect(result.current.formId).toBe('f2')
        expect(result.current.form.getValues('name')).toBe('Keep me')
        expect(result.current.form.getValues('severity')).toBe('low')
    })
    it('seeds defaults when the forms resolve after first render', () => {
        formsOfHost.mockReturnValue({ forms: [], defaultForm: undefined, isReady: false })
        const { result, rerender } = renderHook(() => useFormCreate(host, 'f2', ctx))
        expect(result.current.form.getValues('severity')).toBeUndefined()
        formsOfHost.mockReturnValue(loaded)
        rerender()
        expect(result.current.form.getValues('severity')).toBe('low')
    })
    it('lays initial values over the defaults, once, and keeps them across a form switch', async () => {
        const { result } = renderHook(() =>
            useFormCreate(host, undefined, ctx, { name: 'Typed first' })
        )
        await waitFor(() => expect(result.current.isReady).toBe(true))
        expect(result.current.form.getValues('name')).toBe('Typed first')
        act(() => result.current.switchForm(bug.id))
        expect(result.current.form.getValues('name')).toBe('Typed first')
    })
})

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
const schemas: HostSchemas = { AmountField: z.number().min(0, 'Use 0 or more') }

describe('useFormCreate, host component schemas', () => {
    beforeEach(() =>
        formsOfHost.mockReturnValue({ forms: [gadgetForm], defaultForm: gadgetForm, isReady: true })
    )
    async function submitWith(amount: number) {
        const { result } = renderHook(() =>
            useFormCreate(gadget, undefined, ctx, { amount }, schemas)
        )
        await waitFor(() => expect(result.current.isReady).toBe(true))
        act(() => result.current.form.setValue('title', 'T'))
        let split: Awaited<ReturnType<typeof result.current.submit>> | undefined
        await act(async () => {
            split = await result.current.submit()
        })
        return { split, form: result.current.form }
    }
    it('refuses the submit with the message of the component schema', async () => {
        const refused = await submitWith(-1)
        expect(refused.split).toBeNull()
        expect(refused.form.getFieldState('amount').error?.message).toBe('Use 0 or more')
        const accepted = await submitWith(2)
        expect(accepted.split?.columns.amount).toBe(2)
    })
})
