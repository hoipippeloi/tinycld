// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    gizmos,
    orderDefinition,
    orderFormHost,
    partsDefinition,
} from '../../../lib/forms/__tests__/table-fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { useFormCreate } from '../use-form-create'

const orderForm = {
    id: 'o1',
    host: orderFormHost.key,
    name: 'Order',
    slug: 'order',
    is_default: true,
    archived: false,
    order: 0,
    definition: orderDefinition,
}
const formsOfHost = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/forms/use-forms-of-host', () => ({ useFormsOfHost: formsOfHost }))

const ctx = { today: '2026-01-10', userId: 'me' }

describe('useFormCreate with tables', () => {
    beforeEach(() =>
        formsOfHost.mockReturnValue({ forms: [orderForm], defaultForm: orderForm, isReady: true })
    )

    it('seeds every table with no rows, so totals start at 0', () => {
        const { result } = renderHook(() => useFormCreate(orderFormHost, undefined, ctx))
        expect(result.current.form.getValues('lines')).toEqual([])
    })

    it('submits rows with computed cells filled and cleared numbers as null', async () => {
        const { result } = renderHook(() => useFormCreate(orderFormHost, undefined, ctx))
        act(() => {
            result.current.form.setValue('name', 'N')
            result.current.form.setValue('lines', [
                { id: 'r1', item: 'gear', qty: 2, rate: 1.25 },
                { id: 'r2', item: 'cog', qty: '', rate: 3 },
            ])
        })
        let split: Awaited<ReturnType<typeof result.current.submit>> | undefined
        await act(async () => {
            split = await result.current.submit()
        })
        expect(split?.tables.lines).toEqual([
            { id: 'r1', item: 'gear', qty: 2, rate: 1.25, amount: 2.5 },
            { id: 'r2', item: 'cog', qty: null, rate: 3, amount: 0 },
        ])
        expect(split?.columns).toEqual({ name: 'N', subtotal: 2.5 })
    })

    it('refuses a row whose required cell is empty and names the column', async () => {
        const { result } = renderHook(() => useFormCreate(orderFormHost, undefined, ctx))
        act(() => {
            result.current.form.setValue('name', 'N')
            result.current.form.setValue('lines', [{ id: 'r1', item: null, qty: 1, rate: 1 }])
        })
        let split: Awaited<ReturnType<typeof result.current.submit>> | undefined
        await act(async () => {
            split = await result.current.submit()
        })
        expect(split).toBeNull()
        expect(result.current.form.getFieldState('lines.0.item').error?.message).toBe(
            'Item is required'
        )
    })
})

describe('useFormCreate switching forms with a custom table', () => {
    const formOf = (id: string, definition: typeof partsDefinition, isDefault: boolean) => ({
        id,
        host: gizmos.key,
        name: id,
        slug: id,
        is_default: isDefault,
        archived: false,
        order: 0,
        definition,
    })
    const narrow = definitionSchema.parse({
        ...partsDefinition,
        fields: partsDefinition.fields.map(f =>
            f.key === 'parts'
                ? {
                      ...f,
                      columns: [
                          { key: 'label', kind: 'text', label: 'Label' },
                          { key: 'qty', kind: 'number', label: 'Qty' },
                      ],
                  }
                : f
        ),
    })

    it('completes carried rows against the new form columns, so an added column is null', () => {
        const forms = [formOf('narrow', narrow, true), formOf('wide', partsDefinition, false)]
        formsOfHost.mockReturnValue({ forms, defaultForm: forms[0], isReady: true })
        const { result } = renderHook(() => useFormCreate(gizmos, undefined, ctx))
        act(() => {
            result.current.form.setValue('parts', [
                { id: 'a', label: 'A', qty: 1 },
                { id: 'b', label: 'B', qty: 2 },
            ])
        })
        act(() => result.current.switchForm('wide'))
        expect(result.current.form.getValues('parts')).toEqual([
            { id: 'a', label: 'A', qty: 1, done: null, due: null, size: null },
            { id: 'b', label: 'B', qty: 2, done: null, due: null, size: null },
        ])
    })
})
