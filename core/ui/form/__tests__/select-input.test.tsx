// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SelectInput, useForm, useWatch } from '../index'

afterEach(cleanup)

// The react-native stub renders accessibilityRole/accessibilityLabel as plain
// attributes (lowercased by the DOM), not as ARIA role/name.
function radio(name: string): Element {
    const found = document.querySelector(
        `[accessibilityrole="radio"][accessibilitylabel="${name}"]`
    )
    if (!found) throw new Error(`no radio named ${name}`)
    return found
}

// On a custom element React DOM writes a true boolean prop as an empty
// attribute and drops a false one.
function isChecked(name: string) {
    const value = radio(name).getAttribute('aria-checked')
    return value !== null && value !== 'false'
}

function Harness({ initial }: { initial: string }) {
    const { control } = useForm<{ color: string }>({ defaultValues: { color: initial } })
    const value = useWatch({ control, name: 'color' })
    return (
        <>
            <SelectInput
                control={control}
                name="color"
                label="Color"
                options={[
                    { value: 'r', label: 'Red' },
                    { value: 'b', label: 'Blue' },
                ]}
            />
            <span data-testid="value">{value}</span>
        </>
    )
}

describe('SelectInput', () => {
    it('marks only the selected option as checked', () => {
        render(<Harness initial="b" />)
        expect(isChecked('Blue')).toBe(true)
        expect(isChecked('Red')).toBe(false)
    })

    it('moves the checked state to the option the person picks', () => {
        render(<Harness initial="b" />)
        fireEvent.click(radio('Red'))
        expect(screen.getByTestId('value').textContent).toBe('r')
        expect(isChecked('Red')).toBe(true)
        expect(isChecked('Blue')).toBe(false)
    })
})
