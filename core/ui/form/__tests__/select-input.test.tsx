// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it } from 'vitest'
import { SelectInput } from '../SelectInput'

afterEach(cleanup)

function Harness({ disabled = false }: { disabled?: boolean }) {
    const { control } = useForm({ defaultValues: { s: 'x' } })
    return (
        <SelectInput
            control={control}
            name="s"
            label="Pick"
            disabled={disabled}
            options={[
                { value: 'x', label: 'Ex' },
                { value: 'y', label: 'Why' },
            ]}
        />
    )
}

describe('SelectInput', () => {
    it('marks the chosen option selected for the web accessibility tree', () => {
        render(<Harness />)
        expect(screen.getByText('Ex').closest('[aria-selected="true"]')).not.toBeNull()
        expect(screen.getByText('Why').closest('[aria-selected="false"]')).not.toBeNull()
    })
    it('moves the selection on press and not when disabled', () => {
        const { rerender } = render(<Harness />)
        fireEvent.click(screen.getByText('Why'))
        expect(screen.getByText('Why').closest('[aria-selected="true"]')).not.toBeNull()
        rerender(<Harness disabled />)
        fireEvent.click(screen.getByText('Ex'))
        expect(screen.getByText('Why').closest('[aria-selected="true"]')).not.toBeNull()
    })
})
