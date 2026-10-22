// @vitest-environment happy-dom
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AT,
    calcAdmin,
    calcDefinition,
    calcHost,
    calcRow,
    choose,
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

const F = 'form-formula'

/** Grand total reads a field the form no longer has. */
const missingRow = {
    ...calcRow,
    definition: {
        ...calcDefinition,
        fields: calcDefinition.fields.map(f =>
            f.key === 'grand_total' ? { ...f, expression: { var: 'gone' } } : f
        ),
    },
}
const expressionOf = () => editor().form.getValues(`fields.${AT.grandTotal}.expression`)
const summary = (c: HTMLElement) => q(c, `${F}-summary`)?.textContent
const inputValue = (c: HTMLElement, id: string) => (q(c, id) as HTMLInputElement).value

describe('FormulaEditor on a calculated value', () => {
    it('is shown only for a calculated value', () => {
        const calc = render(<Harness fieldKey="grand_total" />)
        expect(summary(calc.container)).toBe('= 0')
        cleanup()
        const plain = render(<Harness fieldKey="qty" />)
        expect(q(plain.container, F)).toBeNull()
    })

    it('offers the number, toggle and calculated fields, not text, not itself', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'field')
        expect(expressionOf()).toEqual({ var: 'qty' })
        await click(container, `${F}-root-field`)
        expect(q(document.body, `${F}-root-field-rush`)).toBeTruthy()
        expect(q(document.body, `${F}-root-field-tax`)).toBeTruthy()
        expect(q(document.body, `${F}-root-field-note`)).toBeNull()
        expect(q(document.body, `${F}-root-field-grand_total`)).toBeNull()
    })

    it('builds Qty × 2 from menus and one number, and marks the form changed', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'mul')
        await choose(container, `${F}-0-part`, 'field')
        await typeInto(container, `${F}-1-number`, '2')
        expect(expressionOf()).toEqual({ mul: [{ var: 'qty' }, 2] })
        expect(summary(container)).toBe('= Qty × 2')
        expect(editor().isDirty).toBe(true)
    })

    it('reads a cleared or half-typed number as 0, never as no value', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await typeInto(container, `${F}-root-number`, '1.5')
        expect(expressionOf()).toBe(1.5)
        await typeInto(container, `${F}-root-number`, '')
        expect(expressionOf()).toBe(0)
        await typeInto(container, `${F}-root-number`, '-')
        expect(expressionOf()).toBe(0)
        expect(inputValue(container, `${F}-root-number`)).toBe('-')
    })

    it('shows the stored number after a reload drops a typed one', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await typeInto(container, `${F}-root-number`, '7')
        expect(inputValue(container, `${F}-root-number`)).toBe('7')
        await act(async () => {
            editor().reload()
        })
        expect(expressionOf()).toBe(0)
        expect(inputValue(container, `${F}-root-number`)).toBe('0')
    })

    it('adds parts to a sum and removes them down to two', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'add')
        expect(q(container, `${F}-0-remove`)).toBeNull()
        await typeInto(container, `${F}-0-number`, '5')
        await typeInto(container, `${F}-1-number`, '7')
        await click(container, `${F}-root-add`)
        expect(expressionOf()).toEqual({ add: [5, 7, 0] })
        await click(container, `${F}-0-remove`)
        expect(expressionOf()).toEqual({ add: [7, 0] })
        expect(inputValue(container, `${F}-0-number`)).toBe('7')
        expect(q(container, `${F}-0-remove`)).toBeNull()
    })

    it('names each repeated part control by its place, for a screen reader', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        const label = (id: string) => q(container, id)?.getAttribute('accessibilityLabel')
        await choose(container, `${F}-root-part`, 'add')
        await click(container, `${F}-root-add`)
        expect(label(`${F}-root-part`)).toBe('Formula part: Add')
        expect(label(`${F}-root-add`)).toBe('Add part to Add')
        expect(label(`${F}-0-number`)).toBe('Number, part 1')
        expect(label(`${F}-1-number`)).toBe('Number, part 2')
        expect(label(`${F}-1-part`)).toBe('Part 2: Number')
        expect(label(`${F}-2-remove`)).toBe('Remove part 3 of Add')
        await choose(container, `${F}-0-part`, 'mul')
        expect(label(`${F}-0-add`)).toBe('Add part to Multiply, part 1')
        expect(label(`${F}-0-1-number`)).toBe('Number, part 1.2')
        expect(label(`${F}-0-1-part`)).toBe('Part 1.2: Number')
        await choose(container, `${F}-1-part`, 'field')
        expect(label(`${F}-1-field`)).toBe('Field, part 2: Qty')
    })

    it('sums a number column of a table, then counts its rows', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'sumOf')
        expect(expressionOf()).toEqual({ sumOf: [{ var: 'parts' }, 'qty'] })
        await click(container, `${F}-root-column`)
        expect(q(document.body, `${F}-root-column-item`)).toBeNull()
        await click(document.body, `${F}-root-column-total`)
        expect(summary(container)).toBe('= sum of Total in Parts')
        await choose(container, `${F}-root-part`, 'count')
        expect(expressionOf()).toEqual({ count: [{ var: 'parts' }] })
        expect(summary(container)).toBe('= rows in Parts')
    })

    it('wraps a part in Round and takes its places from a menu', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'field')
        await choose(container, `${F}-root-part`, 'round')
        expect(expressionOf()).toEqual({ round: [{ var: 'qty' }, 2] })
        await choose(container, `${F}-root-places`, '0')
        expect(summary(container)).toBe('= round(Qty, 0)')
    })

    it('names a formula cycle under the formula as soon as it is built', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await choose(container, `${F}-root-part`, 'field')
        await choose(container, `${F}-root-field`, 'tax')
        expect(q(container, `${F}-error`)?.textContent).toContain(
            'formula cycle: grand_total → tax → grand_total'
        )
    })

    it('saves a cleared Decimal places as 0', async () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        await typeInto(container, `fields.${AT.grandTotal}.decimals`, '3')
        await typeInto(container, `fields.${AT.grandTotal}.decimals`, '')
        await act(async () => {
            await editor().save()
        })
        expect(lastSaved()?.fields[AT.grandTotal]).toMatchObject({
            key: 'grand_total',
            decimals: 0,
        })
    })

    it('labels the part chip with its purpose and opens its menu on a press', () => {
        const { container } = render(<Harness fieldKey="grand_total" />)
        const chip = q(container, `${F}-root-part`)
        expect(chip?.getAttribute('accessibilityLabel')).toBe('Formula part: Number')
        fireEvent.click(chip as HTMLElement)
        expect(q(document.body, `${F}-root-part-mul`)?.textContent).toContain('Multiply')
    })
    it('shows a field the formula reads but the form lost as missing, and will not save', async () => {
        const { container } = render(<Harness fieldKey="grand_total" row={missingRow} />)
        expect(summary(container)).toBe('= gone (missing)')
        expect(q(container, `${F}-root-field`)?.getAttribute('accessibilityLabel')).toBe(
            'Field: gone (missing)'
        )
        let saved = true
        await act(async () => {
            saved = await editor().save()
        })
        expect(saved).toBe(false)
        expect(saveDefinition).not.toHaveBeenCalled()
        expect(q(container, `${F}-error`)?.textContent).toContain('unknown field gone')
    })
})
