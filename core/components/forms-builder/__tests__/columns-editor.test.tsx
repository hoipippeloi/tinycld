// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orderDefinition, orderFormHost } from '../../../lib/forms/__tests__/table-fixtures'
import {
    AT,
    calcAdmin,
    calcHost,
    calcRow,
    click,
    editor,
    Harness,
    lastSaved,
    q,
    render,
    saveDefinition,
    typeInto,
} from './calculations-harness'

vi.mock('../../../lib/forms/use-form-admin', async importOriginal => ({
    ...(await importOriginal<object>()),
    useFormAdmin: () => calcAdmin,
}))
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: calcRow, isReady: true }),
    useFormsOfHost: () => ({ forms: [calcRow], defaultForm: calcRow, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => calcHost }))

afterEach(cleanup)
beforeEach(() => saveDefinition.mockClear())

/** The input name of a Parts column's property: `fields.9.columns.1.label`. */
const C = <P extends string>(j: number, prop: P) =>
    `fields.${AT.parts}.columns.${j}.${prop}` as const
const columnsOf = () => editor().form.getValues(`fields.${AT.parts}.columns`)
const keys = () => columnsOf().map(c => c.key)
const inputValue = (c: HTMLElement, id: string) => (q(c, id) as HTMLInputElement).value

const labelInput = () =>
    document.body.querySelector(
        'rn-textinput[accessibilityLabel^="Name the"]'
    ) as HTMLElement | null

/** Add column → a kind → the label prompt → Add. */
async function addColumn(container: HTMLElement, kind: string, label: string) {
    await click(container, 'form-column-add')
    await click(document.body, `form-column-kind-${kind}`)
    await act(async () => {
        fireEvent.input(labelInput() as HTMLElement, { target: { value: label } })
    })
    await act(async () => {
        fireEvent.click(screen.getByText('Add'))
    })
}

/** Remove asks first: click the column's remove, then the dialog's Remove. */
async function removeColumn(container: HTMLElement, key: string) {
    await click(container, `form-column-${key}-remove`)
    await act(async () => {
        fireEvent.click(screen.getByText('Remove'))
    })
}

describe('ColumnsEditor', () => {
    it('lists the columns with their kinds and opens one to edit', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        const total = q(container, 'form-column-total-edit')
        expect(total?.textContent).toContain('Total')
        expect(total?.textContent).toContain('Calculated')
        expect(total?.getAttribute('accessibilityLabel')).toBe('Edit column Total')
        expect(q(container, 'form-column-settings')).toBeNull()
        await click(container, 'form-column-total-edit')
        expect(q(container, 'form-column-key')?.textContent).toContain('total')
        expect(q(container, 'form-column-kind')?.textContent).toContain('Calculated')
        expect(inputValue(container, C(3, 'label'))).toBe('Total')
        await click(container, 'form-column-total-edit')
        expect(q(container, 'form-column-settings')).toBeNull()
    })

    it('adds a column of the picked kind, keyed by its label, and opens it', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await addColumn(container, 'number', 'Unit cost')
        expect(columnsOf().at(-1)).toEqual({
            key: 'unit_cost',
            kind: 'number',
            label: 'Unit cost',
            required: false,
            hidden: false,
        })
        expect(q(container, 'form-column-key')?.textContent).toContain('unit_cost')
        expect(editor().isDirty).toBe(true)
    })

    it('keys a column called ID apart from the row id', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await addColumn(container, 'text', 'ID')
        expect(keys().at(-1)).toBe('id_2')
    })

    it('renames a column without changing its key', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-qty-edit')
        await typeInto(container, C(1, 'label'), 'Quantity')
        expect(columnsOf()[1]).toMatchObject({ key: 'qty', label: 'Quantity' })
        expect(q(container, 'form-column-qty-edit')?.textContent).toContain('Quantity')
    })

    it('moves a column and keeps it open', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-price-edit')
        await click(container, 'form-column-price-up')
        expect(keys()).toEqual(['item', 'price', 'qty', 'total'])
        expect(q(container, 'form-column-key')?.textContent).toContain('price')
        expect(inputValue(container, C(1, 'label'))).toBe('Price')
        expect(q(container, 'form-column-price-up')?.getAttribute('accessibilityLabel')).toBe(
            'Move column Price up'
        )
    })

    it('names columns that share a label by their place', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await addColumn(container, 'number', 'Price')
        const label = (id: string) => q(container, id)?.getAttribute('accessibilityLabel')
        expect(label('form-column-price-edit')).toBe('Edit column 3 (Price)')
        expect(label('form-column-price_2-edit')).toBe('Edit column 5 (Price)')
        expect(label('form-column-price-up')).toBe('Move column 3 (Price) up')
        expect(label('form-column-price_2-down')).toBe('Move column 5 (Price) down')
        expect(label('form-column-price_2-remove')).toBe('Remove column 5 (Price)')
        expect(label('form-column-qty-remove')).toBe('Remove column Qty')
    })

    it('removes a column but always keeps one', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await removeColumn(container, 'item')
        await removeColumn(container, 'qty')
        await removeColumn(container, 'price')
        expect(keys()).toEqual(['total'])
        await click(container, 'form-column-total-remove')
        expect(screen.queryByText('Remove')).toBeNull()
        expect(keys()).toEqual(['total'])
    })

    it('keeps the column when the removal is cancelled', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-item-remove')
        await act(async () => {
            fireEvent.click(screen.getByText('Cancel'))
        })
        expect(keys()).toEqual(['item', 'qty', 'price', 'total'])
    })

    it("keeps a column's error on that column when it moves", async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-qty-edit')
        await typeInto(container, C(1, 'label'), '')
        await act(async () => {
            await editor().save()
        })
        expect(editor().form.getFieldState(C(1, 'label')).error).toBeTruthy()
        await click(container, 'form-column-qty-up')
        expect(keys()).toEqual(['qty', 'item', 'price', 'total'])
        expect(editor().form.getFieldState(C(0, 'label')).error).toBeTruthy()
        expect(editor().form.getFieldState(C(1, 'label')).error).toBeUndefined()
    })

    it('asks no Required of a calculated column', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-total-edit')
        expect(q(container, C(3, 'required'))).toBeNull()
        expect(q(container, C(3, 'hidden'))).toBeTruthy()
        await click(container, 'form-column-qty-edit')
        expect(q(container, C(1, 'required'))).toBeTruthy()
    })

    it('marks a required column with a star in the list', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await act(async () => {
            editor().form.setValue(C(1, 'required'), true, { shouldDirty: true })
        })
        expect(q(container, 'form-column-qty-edit')?.textContent).toContain('Qty *')
    })

    it("shows no column or formula editor for a host's own table and total", () => {
        const row = { ...calcRow, host: 'gizmos:order', definition: orderDefinition }
        const lines = render(<Harness fieldKey="lines" row={row} host={orderFormHost} />)
        expect(q(lines.container, 'form-prop-kind')?.textContent).toContain('Table')
        expect(q(lines.container, 'form-columns')).toBeNull()
        cleanup()
        const subtotal = render(<Harness fieldKey="subtotal" row={row} host={orderFormHost} />)
        expect(q(subtotal.container, 'form-prop-kind')?.textContent).toContain('Calculated value')
        expect(q(subtotal.container, 'form-formula')).toBeNull()
    })
})

describe('ColumnSettings by kind', () => {
    it("edits a number column's bounds and drops a cleared one when saved", async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-qty-edit')
        await typeInto(container, C(1, 'min'), '1')
        await typeInto(container, C(1, 'max'), '9.5')
        await typeInto(container, C(1, 'min'), '')
        await act(async () => {
            await editor().save()
        })
        const saved = lastSaved()?.fields[AT.parts]
        const qty = saved?.kind === 'table' ? saved.columns[1] : undefined
        expect(qty).toMatchObject({ key: 'qty', max: 9.5 })
        expect(qty).not.toHaveProperty('min')
    })

    it("limits a text column's length", async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await click(container, 'form-column-item-edit')
        await typeInto(container, C(0, 'maxLength'), '40')
        expect(editor().form.getValues(C(0, 'maxLength'))).toBe(40)
    })

    it('gives a choice list column its options', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await addColumn(container, 'select', 'Size')
        expect(inputValue(container, C(4, 'options.0.label'))).toBe('Option 1')
        await click(container, 'form-option-add')
        expect(editor().form.getValues(C(4, 'options'))).toHaveLength(2)
    })

    it('builds a calculated column from the other columns of its row', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        const F = 'form-column-formula'
        await click(container, 'form-column-total-edit')
        expect(q(container, `${F}-summary`)?.textContent).toBe('= Qty × Price')
        await click(container, `${F}-root-part`)
        expect(q(document.body, `${F}-root-part-field`)?.textContent).toContain('Column')
        expect(q(document.body, `${F}-root-part-sumOf`)).toBeNull()
        expect(q(document.body, `${F}-root-part-count`)).toBeNull()
        await click(document.body, `${F}-root-part-mul`)
        await click(container, `${F}-0-field`)
        expect(q(document.body, `${F}-0-field-price`)).toBeTruthy()
        expect(q(document.body, `${F}-0-field-item`)).toBeNull()
        expect(q(document.body, `${F}-0-field-total`)).toBeNull()
        await click(document.body, `${F}-0-field-price`)
        expect(editor().form.getValues(C(3, 'expression'))).toEqual({
            mul: [{ var: 'price' }, { var: 'price' }],
        })
        await typeInto(container, C(3, 'decimals'), '3')
        expect(editor().form.getValues(C(3, 'decimals'))).toBe(3)
    })
})

describe('OptionsEditor row labels', () => {
    it('names the option in each row button', async () => {
        const { container } = render(<Harness fieldKey="parts" />)
        await addColumn(container, 'select', 'Size')
        const label = 'Option 1'
        expect(q(container, 'form-option-up-0')?.getAttribute('accessibilityLabel')).toBe(
            `Move option ${label} up`
        )
        expect(q(container, 'form-option-down-0')?.getAttribute('accessibilityLabel')).toBe(
            `Move option ${label} down`
        )
        expect(q(container, 'form-option-remove-0')?.getAttribute('accessibilityLabel')).toBe(
            `Remove option ${label}`
        )
    })
})
