// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { UseFormReturn } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gizmos, partsDefinition, rowA, rowB } from '../../../lib/forms/__tests__/table-fixtures'
import type { FormValues } from '../../../lib/forms/logic'
import { byTestId, rowIdsOf, TableHarness } from './table-harness'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function setUp(rows = [rowA, rowB]) {
    const formRef: { current: UseFormReturn<FormValues> | null } = { current: null }
    const view = render(
        <TableHarness
            host={gizmos}
            definition={partsDefinition}
            initialValues={{ name: 'N', parts: rows }}
            formRef={formRef}
        />
    )
    const rowsNow = () => formRef.current?.getValues('parts')
    return { ...view, formRef, rowsNow }
}

describe('TableField', () => {
    it('shows a header with a star on required columns, and one row per value', () => {
        const { container } = setUp()
        expect(byTestId(container, 'form-table-parts-head-label').textContent).toBe('Label *')
        expect(byTestId(container, 'form-table-parts-head-done').textContent).toBe('Done')
        expect(rowIdsOf(container, 'parts')).toEqual(['a', 'b'])
    })

    it('adds a row with every editable cell empty', () => {
        const { container, rowsNow } = setUp()
        fireEvent.click(byTestId(container, 'form-table-parts-add'))
        expect(rowIdsOf(container, 'parts')).toHaveLength(3)
        expect(rowsNow()?.[2]).toEqual({
            id: expect.any(String),
            label: null,
            qty: null,
            done: null,
            due: null,
            size: null,
        })
    })

    it('edits a cell through its own input', () => {
        const { container, rowsNow } = setUp()
        fireEvent.input(byTestId(container, 'form-table-parts-a-label'), {
            target: { value: 'Axle' },
        })
        expect(rowsNow()?.[0]).toMatchObject({ id: 'a', label: 'Axle' })
    })

    it('shows computed cells and totals live', () => {
        const { container } = setUp()
        expect(byTestId(container, 'form-table-parts-a-double').textContent).toBe('2')
        expect(byTestId(container, 'form-input-total_qty').textContent).toBe('3')
        fireEvent.input(byTestId(container, 'form-table-parts-a-qty'), { target: { value: '5' } })
        expect(byTestId(container, 'form-table-parts-a-double').textContent).toBe('10')
        expect(byTestId(container, 'form-input-total_qty').textContent).toBe('7')
    })

    it('keeps a cell edit when its row moves', async () => {
        const { container, rowsNow } = setUp()
        fireEvent.input(byTestId(container, 'form-table-parts-a-qty'), { target: { value: '5' } })
        fireEvent.click(byTestId(container, 'form-table-parts-a-down'))
        await waitFor(() => expect(rowIdsOf(container, 'parts')).toEqual(['b', 'a']))
        expect(rowsNow()).toEqual([rowB, { ...rowA, qty: 5 }])
    })

    it('disables Move up on the first row and Move down on the last', () => {
        const { container, rowsNow } = setUp()
        fireEvent.click(byTestId(container, 'form-table-parts-a-up'))
        fireEvent.click(byTestId(container, 'form-table-parts-b-down'))
        expect(rowsNow()).toEqual([rowA, rowB])
        expect(
            byTestId(container, 'form-table-parts-a-up').getAttribute('accessibilityLabel')
        ).toBe('Move row 1 up')
    })

    it('keeps focus on the moved row so a keyboard user can press again', async () => {
        const focus = vi.spyOn(HTMLElement.prototype, 'focus')
        const third = { ...rowB, id: 'c', label: 'C' }
        const { container } = setUp([rowA, rowB, third])
        fireEvent.click(byTestId(container, 'form-table-parts-a-down'))
        await waitFor(() => expect(rowIdsOf(container, 'parts')).toEqual(['b', 'a', 'c']))
        await waitFor(() =>
            expect(focus.mock.contexts.at(-1)).toBe(byTestId(container, 'form-table-parts-a-down'))
        )
        fireEvent.click(byTestId(container, 'form-table-parts-a-down'))
        await waitFor(() => expect(rowIdsOf(container, 'parts')).toEqual(['b', 'c', 'a']))
        // At the bottom Move down is disabled, so focus takes the row's Move up.
        await waitFor(() =>
            expect(focus.mock.contexts.at(-1)).toBe(byTestId(container, 'form-table-parts-a-up'))
        )
    })

    it('removes a row and puts focus on Add row', async () => {
        const focus = vi.spyOn(HTMLElement.prototype, 'focus')
        const { container, rowsNow } = setUp()
        fireEvent.click(byTestId(container, 'form-table-parts-a-remove'))
        expect(rowsNow()).toEqual([rowB])
        await waitFor(() =>
            expect(focus.mock.contexts.at(-1)).toBe(byTestId(container, 'form-table-parts-add'))
        )
    })

    it('says so when there are no rows', () => {
        const { container } = setUp([])
        expect(byTestId(container, 'form-table-parts-empty').textContent).toBe('No rows yet.')
    })
})
