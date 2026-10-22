// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { UseFormReturn } from 'react-hook-form'
import { Pressable, Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gizmos, orderDefinition, orderFormHost } from '../../../lib/forms/__tests__/table-fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import type { BuiltinFieldProps } from '../../../lib/forms/host-ui'
import type { FormValues } from '../../../lib/forms/logic'
import { byTestId, TableHarness } from './table-harness'

afterEach(cleanup)

const seen = vi.fn()

function ItemCell(props: BuiltinFieldProps) {
    seen(props)
    const rowId = props.table?.row.id ?? 'none'
    const pick = () => props.table?.onRowChange({ item: 'gear', rate: 4 })
    return (
        <Pressable testID={`item-cell-${rowId}`} onPress={pick} disabled={props.disabled}>
            <Text testID={`item-value-${rowId}`}>{String(props.value ?? '')}</Text>
        </Pressable>
    )
}

const ui = { components: { ItemCell } }
const line = { id: 'r1', item: null, qty: 3, rate: null }

function setUp() {
    const formRef: { current: UseFormReturn<FormValues> | null } = { current: null }
    const view = render(
        <TableHarness
            host={orderFormHost}
            definition={orderDefinition}
            initialValues={{ name: 'N', lines: [line] }}
            ui={ui}
            formRef={formRef}
        />
    )
    return { ...view, formRef }
}

describe('host table cells', () => {
    it('mounts the host component with the cell value and the row context', () => {
        setUp()
        expect(seen).toHaveBeenLastCalledWith(
            expect.objectContaining({
                fieldKey: 'lines',
                label: 'Item, row 1',
                value: null,
                mode: 'create',
                disabled: false,
                table: expect.objectContaining({
                    columnKey: 'item',
                    rowIndex: 0,
                    row: { id: 'r1', item: null, qty: 3, rate: null, amount: 0 },
                }),
            })
        )
    })

    it('sets sibling cells in one change and the totals follow', async () => {
        const { container, formRef } = setUp()
        fireEvent.click(byTestId(container, 'item-cell-r1'))
        await waitFor(() => expect(byTestId(container, 'item-value-r1').textContent).toBe('gear'))
        expect(formRef.current?.getValues('lines.0')).toEqual({
            id: 'r1',
            item: 'gear',
            qty: 3,
            rate: 4,
        })
        expect(byTestId(container, 'form-table-lines-r1-amount').textContent).toBe('12.00')
        expect(byTestId(container, 'form-input-subtotal').textContent).toBe('12.00')
    })

    it('shows the cell error under a host-drawn cell', async () => {
        const { container, formRef } = setUp()
        await act(async () => {
            await formRef.current?.trigger('lines')
        })
        expect(container.textContent).toContain('Item is required')
    })

    it('never mounts a host component for a custom table column', () => {
        const def = definitionSchema.parse({
            version: 1,
            pages: [{ key: 'main', title: 'Main' }],
            fields: [
                {
                    key: 'parts',
                    kind: 'table',
                    page: 'main',
                    label: 'Parts',
                    columns: [{ key: 'item', kind: 'text', label: 'Item', component: 'ItemCell' }],
                },
            ],
        })
        const { container } = render(
            <TableHarness
                host={gizmos}
                definition={def}
                initialValues={{ parts: [{ id: 'p1', item: 'x' }] }}
                ui={ui}
            />
        )
        expect(container.querySelector('[testID="item-cell-p1"]')).toBeNull()
        expect(byTestId(container, 'form-table-parts-p1-item')).toBeTruthy()
    })
})
