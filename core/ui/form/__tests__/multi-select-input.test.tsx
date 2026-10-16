// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MultiSelectInput, useForm, useWatch } from '../index'

afterEach(cleanup)

// The react-native stub renders accessibilityRole/accessibilityLabel as plain
// attributes (lowercased by the DOM), not as ARIA role/name.
function checkbox(name: string): Element {
    const found = document.querySelector(
        `[accessibilityrole="checkbox"][accessibilitylabel="${name}"]`
    )
    if (!found) throw new Error(`no checkbox named ${name}`)
    return found
}

function Harness({ initial }: { initial: string[] }) {
    const { control } = useForm<{ groups: string[] }>({ defaultValues: { groups: initial } })
    const value = useWatch({ control, name: 'groups' })
    return (
        <>
            <MultiSelectInput
                control={control}
                name="groups"
                label="Groups"
                options={[
                    { value: 'g1', label: 'Sales' },
                    { value: 'g2', label: 'Support' },
                ]}
            />
            <span data-testid="value">{value.join(',')}</span>
        </>
    )
}

// On a custom element React DOM writes a true boolean prop as an empty
// attribute and drops a false one.
function isChecked(name: string) {
    const value = checkbox(name).getAttribute('aria-checked')
    return value !== null && value !== 'false'
}

describe('MultiSelectInput', () => {
    it('adds and removes values in option order', () => {
        render(<Harness initial={[]} />)
        fireEvent.click(checkbox('Support'))
        fireEvent.click(checkbox('Sales'))
        expect(screen.getByTestId('value').textContent).toBe('g1,g2')
        fireEvent.click(checkbox('Sales'))
        expect(screen.getByTestId('value').textContent).toBe('g2')
    })

    it('marks selected options as checked', () => {
        render(<Harness initial={['g2']} />)
        expect(isChecked('Support')).toBe(true)
        expect(isChecked('Sales')).toBe(false)
    })

    it('shows emptyText when there are no options', () => {
        const Empty = () => {
            const { control } = useForm<{ groups: string[] }>({ defaultValues: { groups: [] } })
            return (
                <MultiSelectInput
                    control={control}
                    name="groups"
                    label="Groups"
                    options={[]}
                    emptyText="No groups yet"
                />
            )
        }
        render(<Empty />)
        expect(screen.getByText('No groups yet')).toBeTruthy()
    })
})
