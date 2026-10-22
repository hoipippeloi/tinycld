// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    fieldOf,
    gizmos,
    orderDefinition,
    orderFormHost,
    partsDefinition,
} from '../../../lib/forms/__tests__/table-fixtures'
import type { FormField } from '../../../lib/forms/definition'
import type { BuiltinFieldProps, FieldMode, FormHostUi } from '../../../lib/forms/host-ui'
import type { FormValues } from '../../../lib/forms/logic'
import type { FormHost } from '../../../lib/packages/derive-form-hosts'
import { FieldInput } from '../FieldInput'
import { formatComputed } from '../fields/format-computed'

afterEach(cleanup)

interface HarnessProps {
    host: FormHost
    field: FormField
    mode?: FieldMode
    computed?: FormValues
    initial?: FormValues
    ui?: FormHostUi | null
}

function Harness({
    host,
    field,
    mode = 'create',
    computed,
    initial = {},
    ui = null,
}: HarnessProps) {
    const { control, getValues } = useForm<FormValues>({ defaultValues: initial })
    return (
        <FieldInput
            host={host}
            ui={ui}
            field={field}
            control={control}
            getValues={getValues}
            mode={mode}
            computed={computed}
        />
    )
}

const textOf = (container: HTMLElement, id: string) =>
    container.querySelector(`[testID="${id}"]`)?.textContent

describe('formatComputed', () => {
    it('fixes the decimals and reads a non-number as empty', () => {
        expect(formatComputed(12.5, 2)).toBe('12.50')
        expect(formatComputed(-0, 2)).toBe('0.00')
        expect(formatComputed(7, 0)).toBe('7')
        expect(formatComputed(null, 2)).toBe('')
        expect(formatComputed(Number.NaN, 2)).toBe('')
    })
})

describe('computed fields', () => {
    const totalQty = fieldOf(partsDefinition, 'total_qty')
    const subtotal = fieldOf(orderDefinition, 'subtotal')

    it('shows the live computed value of a custom field', () => {
        const { container } = render(
            <Harness host={gizmos} field={totalQty} computed={{ total_qty: 7 }} />
        )
        expect(textOf(container, 'form-input-total_qty')).toBe('7')
    })

    it('shows a host computed built-in at its decimals', () => {
        const { container } = render(
            <Harness host={orderFormHost} field={subtotal} computed={{ subtotal: 12.5 }} />
        )
        expect(textOf(container, 'form-input-subtotal')).toBe('12.50')
    })

    it('falls back to the form value without computed values, and a dash with none', () => {
        const stored = render(<Harness host={gizmos} field={totalQty} initial={{ total_qty: 3 }} />)
        expect(textOf(stored.container, 'form-input-total_qty')).toBe('3')
        cleanup()
        const empty = render(<Harness host={gizmos} field={totalQty} />)
        expect(textOf(empty.container, 'form-input-total_qty')).toBe('—')
    })

    it('shows Calculated on the design canvas', () => {
        const { container } = render(<Harness host={gizmos} field={totalQty} mode="design" />)
        expect(textOf(container, 'form-input-total_qty')).toBe('Calculated')
    })

    it('hands a host component the live computed value, read-only', () => {
        const seen = vi.fn()
        function Money(props: BuiltinFieldProps) {
            seen(props)
            return null
        }
        render(
            <Harness
                host={orderFormHost}
                field={subtotal}
                mode="edit"
                computed={{ subtotal: 12.5 }}
                initial={{ subtotal: 99 }}
                ui={{ components: { Money } }}
            />
        )
        expect(seen).toHaveBeenLastCalledWith(
            expect.objectContaining({ fieldKey: 'subtotal', value: 12.5, disabled: true })
        )
    })
})
