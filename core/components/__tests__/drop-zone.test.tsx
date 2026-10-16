// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropZone } from '../DropZone'

afterEach(cleanup)

function fileDrag(type: 'dragOver' | 'drop', el: HTMLElement, types: string[]) {
    const event = createEvent[type](el)
    const dataTransfer = { types, files: [new File(['x'], 'a.txt')], dropEffect: 'move' }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    fireEvent(el, event)
    return { defaultPrevented: event.defaultPrevented, dropEffect: dataTransfer.dropEffect }
}

// Stands in for an editor inside the zone: ProseMirror claims a drag with a
// native listener, before the event bubbles to the zone.
function claimingChild(el: HTMLElement | null) {
    el?.addEventListener('dragover', e => e.preventDefault())
    el?.addEventListener('drop', e => e.preventDefault())
}

function renderZone(isEnabled: boolean) {
    const onDrop = vi.fn()
    const { getByTestId } = render(
        <DropZone onDrop={onDrop} isEnabled={isEnabled} testID="zone">
            <span>body</span>
            <span ref={claimingChild} data-testid="editor">
                editor
            </span>
        </DropZone>
    )
    return { zone: getByTestId('zone'), editor: getByTestId('editor'), onDrop }
}

describe('DropZone', () => {
    it('a disabled zone still stops the browser opening a dragged file', () => {
        const { zone, onDrop } = renderZone(false)
        expect(fileDrag('dragOver', zone, ['Files'])).toEqual({
            defaultPrevented: true,
            dropEffect: 'none',
        })
        expect(fileDrag('drop', zone, ['Files']).defaultPrevented).toBe(true)
        expect(onDrop).not.toHaveBeenCalled()
    })

    it('a disabled zone leaves a drag an inner target claimed alone', () => {
        const { editor, onDrop } = renderZone(false)
        expect(fileDrag('dragOver', editor, ['Files']).dropEffect).toBe('move')
        fileDrag('drop', editor, ['Files'])
        expect(onDrop).not.toHaveBeenCalled()
    })

    it('an enabled zone does not upload a drop an inner target claimed', () => {
        const { editor, onDrop } = renderZone(true)
        fileDrag('drop', editor, ['Files'])
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
