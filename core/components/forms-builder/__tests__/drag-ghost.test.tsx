// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { chipPosition, DragGhost } from '../DragGhost'
import { type CanvasDrag, createPointerStore } from '../use-canvas-drag'

afterEach(cleanup)

type Measurable = HTMLElement & { measureInWindow?: (cb: (...n: number[]) => void) => void }

/** Lays the overlay out at a window origin, as the editor's root would. */
function layOut(el: HTMLElement | null, x: number, y: number) {
    const node = el as Measurable
    node.measureInWindow = cb => cb(x, y, 800, 600)
    fireEvent(node, new CustomEvent('rn-layout', { detail: { width: 800, height: 600, x, y } }))
}

function dragWith(draggingKey: string | null) {
    const pointer = createPointerStore()
    return { drag: { draggingKey, pointer } as unknown as CanvasDrag, pointer }
}

const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null

describe('DragGhost', () => {
    it('renders nothing while no field is dragged', () => {
        const { drag } = dragWith(null)
        const { container } = render(<DragGhost drag={drag} label="Name" />)
        expect(q(container, 'form-drag-overlay')).toBeNull()
    })

    it('follows the pointer in the overlay’s own frame once both are known', () => {
        const { drag, pointer } = dragWith('name')
        const { container, getByText } = render(<DragGhost drag={drag} label="Name" />)
        const overlay = q(container, 'form-drag-overlay')
        expect(overlay).toBeTruthy()
        expect(q(container, 'form-drag-ghost')).toBeNull()
        act(() => pointer.set({ x: 300, y: 200 }))
        // The pointer alone is not enough: the overlay's origin is still unknown.
        expect(q(container, 'form-drag-ghost')).toBeNull()
        act(() => layOut(overlay, 100, 50))
        const chip = q(container, 'form-drag-ghost')
        expect(chip?.style.left).toBe('212px')
        expect(chip?.style.top).toBe('158px')
        expect(getByText('Name')).toBeTruthy()
        act(() => pointer.set({ x: 310, y: 220 }))
        expect(q(container, 'form-drag-ghost')?.style.left).toBe('222px')
        expect(q(container, 'form-drag-ghost')?.style.top).toBe('178px')
    })

    it('does not catch pointer events, so the drag underneath keeps them', () => {
        const { drag } = dragWith('name')
        const { container } = render(<DragGhost drag={drag} label="Name" />)
        expect(q(container, 'form-drag-overlay')?.getAttribute('pointerEvents')).toBe('none')
    })
})

describe('chipPosition', () => {
    it('offsets the chip from the pointer, relative to the overlay', () => {
        expect(chipPosition(null, { x: 0, y: 0 })).toBeNull()
        expect(chipPosition({ x: 10, y: 10 }, null)).toBeNull()
        expect(chipPosition({ x: 110, y: 60 }, { x: 100, y: 50 })).toEqual({ x: 22, y: 18 })
    })
})
