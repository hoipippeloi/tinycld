// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverlayProvider } from '../../overlay'
import { PickMenu } from '../index'

afterEach(cleanup)

// RN stub hosts carry `testID`; Menu rows are DOM elements with `data-testid`
// under the overlay host, outside the render container.
const q = (id: string) =>
    document.body.querySelector(`[testID="${id}"], [data-testid="${id}"]`) as HTMLElement | null

describe('PickMenu', () => {
    it('opens on the trigger and selects an item', () => {
        const onSelect = vi.fn()
        render(
            <OverlayProvider>
                <PickMenu
                    label="Bug"
                    purpose="Type"
                    testID="t"
                    items={[
                        { id: 'a', label: 'Bug', isSelected: true, onSelect: vi.fn() },
                        { id: 'b', label: 'Task', onSelect },
                    ]}
                />
            </OverlayProvider>
        )
        const trigger = q('t') as HTMLElement
        expect(
            trigger.getAttribute('accessibilityLabel') ?? trigger.getAttribute('aria-label')
        ).toBe('Type: Bug')
        fireEvent.click(trigger)
        fireEvent.click(q('t-b') as HTMLElement)
        expect(onSelect).toHaveBeenCalledTimes(1)
    })
})
