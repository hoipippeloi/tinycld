// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChecklistField } from '../fields/ChecklistField'

afterEach(cleanup)

function byTestId(container: HTMLElement, id: string) {
    const el = container.querySelector(`[testID="${id}"]`)
    if (!el) throw new Error(`no element with testID ${id}`)
    return el
}

describe('ChecklistField with local storage', () => {
    it('adds an item from the composer', () => {
        const onChange = vi.fn()
        const { container } = render(<ChecklistField value={[]} onChange={onChange} testID="cl" />)
        const input = byTestId(container, 'cl-new')
        fireEvent.input(input, { target: { value: 'Write tests' } })
        fireEvent(input, new Event('SubmitEditing'))
        expect(onChange).toHaveBeenCalledTimes(1)
        const items = onChange.mock.calls[0][0] as { id: string; text: string; done: boolean }[]
        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ text: 'Write tests', done: false })
        expect(items[0].id).toHaveLength(15)
    })

    it('toggles done through onChange', () => {
        const onChange = vi.fn()
        const { container } = render(
            <ChecklistField
                value={[{ id: 'abc', text: 'a', done: false }]}
                onChange={onChange}
                testID="cl"
            />
        )
        fireEvent.click(byTestId(container, 'cl-toggle-abc'))
        expect(onChange).toHaveBeenCalledWith([{ id: 'abc', text: 'a', done: true }])
    })

    it('removes an item', () => {
        const onChange = vi.fn()
        const { container } = render(
            <ChecklistField
                value={[{ id: 'abc', text: 'a', done: false }]}
                onChange={onChange}
                testID="cl"
            />
        )
        fireEvent.click(byTestId(container, 'cl-remove-abc'))
        expect(onChange).toHaveBeenCalledWith([])
    })
})
