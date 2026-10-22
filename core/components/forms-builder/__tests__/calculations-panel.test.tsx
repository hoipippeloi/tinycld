// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AT, calcAdmin, calcHost, calcRow, Harness, q, render } from './calculations-harness'

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

describe('FieldProperties for a table and a calculated value', () => {
    it('names their kinds', () => {
        const table = render(<Harness fieldKey="parts" />)
        expect(q(table.container, 'form-prop-kind')?.textContent).toContain('Table')
        cleanup()
        const calc = render(<Harness fieldKey="grand_total" />)
        expect(q(calc.container, 'form-prop-kind')?.textContent).toContain('Calculated value')
    })

    it('offers no placeholder for either, and no Required for a calculated value', () => {
        const table = render(<Harness fieldKey="parts" />)
        expect(q(table.container, `fields.${AT.parts}.placeholder`)).toBeNull()
        expect(q(table.container, `fields.${AT.parts}.required`)).toBeTruthy()
        cleanup()
        const calc = render(<Harness fieldKey="grand_total" />)
        expect(q(calc.container, `fields.${AT.grandTotal}.placeholder`)).toBeNull()
        expect(q(calc.container, `fields.${AT.grandTotal}.required`)).toBeNull()
        cleanup()
        const plain = render(<Harness fieldKey="qty" />)
        expect(q(plain.container, `fields.${AT.qty}.placeholder`)).toBeTruthy()
        expect(q(plain.container, `fields.${AT.qty}.required`)).toBeTruthy()
    })
})
