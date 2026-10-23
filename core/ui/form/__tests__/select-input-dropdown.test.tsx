// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverlayProvider } from '../../overlay'
import { SelectInput } from '../SelectInput'

afterEach(cleanup)

let latest: () => string = () => ''

function Harness({
    disabled = false,
    initial = 'x',
    hint,
    placeholder,
    onValueChange,
}: {
    disabled?: boolean
    initial?: string
    hint?: string
    placeholder?: string
    onValueChange?: (value: string) => void
}) {
    const { control, getValues } = useForm({ defaultValues: { s: initial } })
    latest = () => getValues('s')
    return (
        <OverlayProvider>
            <SelectInput
                control={control}
                name="s"
                label="Pick"
                presentation="dropdown"
                testID="pick"
                hint={hint}
                placeholder={placeholder}
                disabled={disabled}
                onValueChange={onValueChange}
                options={[
                    { value: 'x', label: 'Ex' },
                    { value: 'y', label: 'Why' },
                ]}
            />
        </OverlayProvider>
    )
}

const q = (id: string) =>
    document.body.querySelector(`[testID="${id}"], [data-testid="${id}"]`) as HTMLElement | null
const labelOf = (el: HTMLElement | null) =>
    el?.getAttribute('accessibilityLabel') ?? el?.getAttribute('aria-label')

describe('SelectInput presentation="dropdown"', () => {
    it('renders a trigger, not a radio group', () => {
        render(<Harness />)
        expect(q('pick')).not.toBeNull()
        expect(document.querySelector('[accessibilityrole="radiogroup"]')).toBeNull()
        expect(document.querySelector('[accessibilityrole="radio"]')).toBeNull()
    })

    it('shows the field label, the selected option label and an accessible name combining them', () => {
        render(<Harness />)
        expect(document.body.textContent).toContain('Pick')
        expect(q('pick')?.textContent).toContain('Ex')
        expect(labelOf(q('pick'))).toBe('Pick: Ex')
    })

    it('is 44pt tall', () => {
        render(<Harness />)
        expect((q('pick') as HTMLElement).style.minHeight).toBe('44px')
    })

    it('shows the placeholder when no option matches the value', () => {
        render(<Harness initial="" placeholder="Select one" />)
        expect(q('pick')?.textContent).toContain('Select one')
        expect(labelOf(q('pick'))).toBe('Pick: Select one')
    })

    it('opens a menu with one item per option, each with a testID of testID-value', () => {
        render(<Harness />)
        expect(q('pick-y')).toBeNull()
        fireEvent.click(q('pick') as HTMLElement)
        expect(q('pick-x')?.textContent).toContain('Ex')
        expect(q('pick-y')?.textContent).toContain('Why')
    })

    it('sets the value, updates the trigger and calls onValueChange once on a real change', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        fireEvent.click(q('pick') as HTMLElement)
        fireEvent.click(q('pick-y') as HTMLElement)
        expect(latest()).toBe('y')
        expect(onValueChange).toHaveBeenCalledTimes(1)
        expect(onValueChange).toHaveBeenCalledWith('y')
        expect(labelOf(q('pick'))).toBe('Pick: Why')
    })

    it('does not call onValueChange when the current option is picked again', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        fireEvent.click(q('pick') as HTMLElement)
        fireEvent.click(q('pick-x') as HTMLElement)
        expect(onValueChange).not.toHaveBeenCalled()
        expect(latest()).toBe('x')
    })

    it('does not open or change anything when disabled', () => {
        const onValueChange = vi.fn()
        render(<Harness disabled onValueChange={onValueChange} />)
        expect(q('pick')?.getAttribute('aria-disabled')).toBe('true')
        fireEvent.click(q('pick') as HTMLElement)
        expect(q('pick-y')).toBeNull()
        expect(onValueChange).not.toHaveBeenCalled()
        expect(latest()).toBe('x')
    })

    it('renders the hint', () => {
        render(<Harness hint="Cannot change" />)
        expect(document.body.textContent).toContain('Cannot change')
    })
})

describe('SelectInput default presentation', () => {
    it('stays a radio group when presentation is not given', () => {
        function Plain() {
            const { control } = useForm({ defaultValues: { s: 'x' } })
            return (
                <SelectInput
                    control={control}
                    name="s"
                    label="Pick"
                    options={[{ value: 'x', label: 'Ex' }]}
                />
            )
        }
        render(<Plain />)
        expect(document.querySelector('[accessibilityrole="radiogroup"]')).not.toBeNull()
    })
})
