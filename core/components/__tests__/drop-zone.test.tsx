// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropZone } from '../DropZone'

afterEach(cleanup)

function fileDrag(type: 'dragOver' | 'drop', el: HTMLElement, types: string[]) {
    const event = createEvent[type](el)
    Object.defineProperty(event, 'dataTransfer', {
        value: { types, files: [new File(['x'], 'a.txt')], dropEffect: 'move' },
    })
    fireEvent(el, event)
    return event
}

function renderZone(isEnabled: boolean) {
    const onDrop = vi.fn()
    const { getByTestId } = render(
        <DropZone onDrop={onDrop} isEnabled={isEnabled} testID="zone">
            <span>body</span>
        </DropZone>
    )
    return { zone: getByTestId('zone'), onDrop }
}

describe('DropZone', () => {
    it('a disabled zone still stops the browser opening a dragged file', () => {
        const { zone, onDrop } = renderZone(false)
        expect(fileDrag('dragOver', zone, ['Files']).defaultPrevented).toBe(true)
        expect(fileDrag('drop', zone, ['Files']).defaultPrevented).toBe(true)
        expect(onDrop).not.toHaveBeenCalled()
    })

    it('a disabled zone leaves a drag without files alone', () => {
        const { zone } = renderZone(false)
        expect(fileDrag('dragOver', zone, ['text/plain']).defaultPrevented).toBe(false)
    })

    it('an enabled zone hands the dropped files over', () => {
        const { zone, onDrop } = renderZone(true)
        expect(fileDrag('drop', zone, ['Files']).defaultPrevented).toBe(true)
        expect(onDrop).toHaveBeenCalledTimes(1)
    })
})
