// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useFileDrop } from '@tinycld/core/lib/file-drop/use-file-drop'
import { describe, expect, it, vi } from 'vitest'

function fileDrag(type: string, el: HTMLElement, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files, dropEffect: 'move' },
    })
    act(() => {
        el.dispatchEvent(event)
    })
    return event
}

describe('useFileDrop with a drag-time gate', () => {
    it('shows no ring, keeps the drop alive and reports it refused when the gate says no', () => {
        const onFiles = vi.fn()
        const onRefused = vi.fn()
        const { result } = renderHook(() =>
            useFileDrop({ onFiles, onRefused, isEnabled: () => false })
        )
        const el = document.createElement('div')
        act(() => result.current.dropRef(el))

        const enter = fileDrag('dragenter', el)
        expect(enter.defaultPrevented).toBe(true)
        expect(result.current.isDragging).toBe(false)

        const over = fileDrag('dragover', el)
        expect(over.dataTransfer?.dropEffect).toBe('copy')

        const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
        const drop = fileDrag('drop', el, [file])
        expect(drop.defaultPrevented).toBe(true)
        expect(onFiles).not.toHaveBeenCalled()
        expect(onRefused).toHaveBeenCalledTimes(1)
        expect(onRefused).toHaveBeenCalledWith([file])
    })

    it('shows the refusal on the cursor when the target does not explain it', () => {
        const onFiles = vi.fn()
        const { result } = renderHook(() => useFileDrop({ onFiles, isEnabled: () => false }))
        const el = document.createElement('div')
        act(() => result.current.dropRef(el))

        const enter = fileDrag('dragenter', el)
        expect(enter.defaultPrevented).toBe(true)
        expect(result.current.isDragging).toBe(false)

        const over = fileDrag('dragover', el)
        expect(over.defaultPrevented).toBe(true)
        expect(over.dataTransfer?.dropEffect).toBe('none')
    })

    it('reports nothing for a refused drop that carries no files', () => {
        const onFiles = vi.fn()
        const onRefused = vi.fn()
        const { result } = renderHook(() =>
            useFileDrop({ onFiles, onRefused, isEnabled: () => false })
        )
        const el = document.createElement('div')
        act(() => result.current.dropRef(el))

        const drop = fileDrag('drop', el)
        expect(drop.defaultPrevented).toBe(true)
        expect(onFiles).not.toHaveBeenCalled()
        expect(onRefused).not.toHaveBeenCalled()
    })

    it('lights up and delivers when the gate says yes', () => {
        const onFiles = vi.fn()
        const onRefused = vi.fn()
        const { result } = renderHook(() =>
            useFileDrop({ onFiles, onRefused, isEnabled: () => true })
        )
        const el = document.createElement('div')
        act(() => result.current.dropRef(el))
        fileDrag('dragenter', el)
        expect(result.current.isDragging).toBe(true)

        const over = fileDrag('dragover', el)
        expect(over.dataTransfer?.dropEffect).toBe('copy')

        const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
        fileDrag('drop', el, [file])
        expect(result.current.isDragging).toBe(false)
        expect(onFiles).toHaveBeenCalledWith([file])
        expect(onRefused).not.toHaveBeenCalled()
    })
})
