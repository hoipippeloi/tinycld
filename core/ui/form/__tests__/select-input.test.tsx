// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectInput } from '../SelectInput'

afterEach(cleanup)

let latest: () => string = () => ''

function Harness({
    disabled = false,
    onValueChange,
}: {
    disabled?: boolean
    onValueChange?: (value: string) => void
}) {
    const { control, getValues } = useForm({ defaultValues: { s: 'x' } })
    latest = () => getValues('s')
    return (
        <SelectInput
            control={control}
            name="s"
            label="Pick"
            disabled={disabled}
            onValueChange={onValueChange}
            options={[
                { value: 'x', label: 'Ex' },
                { value: 'y', label: 'Why' },
            ]}
        />
    )
}

describe('SelectInput', () => {
    it('marks the chosen option checked for the web accessibility tree', () => {
        render(<Harness />)
        expect(screen.getByText('Ex').closest('[aria-checked="true"]')).not.toBeNull()
        expect(screen.getByText('Why').closest('[aria-checked="false"]')).not.toBeNull()
    })
    it('moves the selection on press and not when disabled', () => {
        const { rerender } = render(<Harness />)
        fireEvent.click(screen.getByText('Why'))
        expect(screen.getByText('Why').closest('[aria-checked="true"]')).not.toBeNull()
        rerender(<Harness disabled />)
        fireEvent.click(screen.getByText('Ex'))
        expect(screen.getByText('Why').closest('[aria-checked="true"]')).not.toBeNull()
    })

    it('calls onValueChange once with the new value and updates the form value', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        fireEvent.click(screen.getByText('Why'))
        expect(onValueChange).toHaveBeenCalledTimes(1)
        expect(onValueChange).toHaveBeenCalledWith('y')
        expect(latest()).toBe('y')
    })
    it('changes the form value the same way when no onValueChange is given', () => {
        render(<Harness />)
        fireEvent.click(screen.getByText('Why'))
        expect(latest()).toBe('y')
    })
    it('does not call onValueChange when disabled', () => {
        const onValueChange = vi.fn()
        render(<Harness disabled onValueChange={onValueChange} />)
        fireEvent.click(screen.getByText('Why'))
        expect(onValueChange).not.toHaveBeenCalled()
    })

    it('does not call onValueChange when the already selected option is pressed', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        fireEvent.click(screen.getByText('Ex'))
        expect(onValueChange).not.toHaveBeenCalled()
        expect(latest()).toBe('x')
    })
    it('calls onValueChange only for the real change when the selected option is pressed again', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        fireEvent.click(screen.getByText('Why'))
        fireEvent.click(screen.getByText('Why'))
        expect(onValueChange).toHaveBeenCalledTimes(1)
        expect(onValueChange).toHaveBeenCalledWith('y')
    })
    it('leaves the form value unchanged when disabled', () => {
        render(<Harness disabled />)
        fireEvent.click(screen.getByText('Why'))
        expect(latest()).toBe('x')
    })
})
