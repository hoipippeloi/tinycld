// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    findSlot,
    positionOf,
    type Rect,
    shiftRects,
    slotToPosition,
    useCanvasDrag,
} from '../use-canvas-drag'

const cells = new Map([
    ['a', { page: 'p1', x: 0, y: 0, width: 100, height: 40 }],
    ['b', { page: 'p1', x: 100, y: 0, width: 100, height: 40 }],
    ['c', { page: 'p2', x: 0, y: 100, width: 200, height: 40 }],
])
const pages = new Map([
    ['p1', { x: 0, y: 0, width: 200, height: 60 }],
    ['p2', { x: 0, y: 100, width: 200, height: 80 }],
])
const order = [
    { page: 'p1', keys: ['a', 'b'] },
    { page: 'p2', keys: ['c'] },
]

describe('findSlot', () => {
    it('targets before or after a cell by its horizontal midpoint', () => {
        expect(findSlot({ x: 20, y: 20 }, cells, pages)).toEqual({ key: 'a', side: 'before' })
        expect(findSlot({ x: 80, y: 20 }, cells, pages)).toEqual({ key: 'a', side: 'after' })
        expect(findSlot({ x: 150, y: 20 }, cells, pages)).toEqual({ key: 'b', side: 'after' })
    })
    it('targets the end of a page when over its empty area', () => {
        expect(findSlot({ x: 100, y: 170 }, cells, pages)).toEqual({ page: 'p2', end: true })
    })
    it('returns null outside every page', () => {
        expect(findSlot({ x: 100, y: 300 }, cells, pages)).toBeNull()
    })
})

describe('shiftRects', () => {
    it('moves every rect by the offset and keeps the other properties', () => {
        const shifted = shiftRects(cells, { x: 0, y: -100 })
        expect(shifted.get('c')).toEqual({ page: 'p2', x: 0, y: 0, width: 200, height: 40 })
        expect(cells.get('c')?.y).toBe(100)
    })
    it('lets findSlot hit a cell after the canvas scrolled', () => {
        // Measured at scroll 0; the canvas then scrolled down 100, so c now sits at y 0.
        const scrolled = { x: 0, y: -100 }
        expect(
            findSlot({ x: 20, y: 20 }, shiftRects(cells, scrolled), shiftRects(pages, scrolled))
        ).toEqual({ key: 'c', side: 'before' })
    })
})

describe('slotToPosition', () => {
    it('converts a slot to a page and index, skipping the dragged key', () => {
        expect(slotToPosition({ key: 'b', side: 'before' }, order, 'a')).toEqual({
            page: 'p1',
            index: 0,
        })
        expect(slotToPosition({ key: 'b', side: 'after' }, order, 'a')).toEqual({
            page: 'p1',
            index: 1,
        })
        expect(slotToPosition({ key: 'c', side: 'before' }, order, 'a')).toEqual({
            page: 'p2',
            index: 0,
        })
        expect(slotToPosition({ page: 'p2', end: true }, order, 'a')).toEqual({
            page: 'p2',
            index: 1,
        })
    })
})

describe('positionOf', () => {
    it('finds the page and index a field sits at now', () => {
        expect(positionOf('b', order)).toEqual({ page: 'p1', index: 1 })
        expect(positionOf('c', order)).toEqual({ page: 'p2', index: 0 })
        expect(positionOf('zz', order)).toBeNull()
    })
})

function deferred() {
    let resolve: (rect: Rect | null) => void = () => {}
    const promise = new Promise<Rect | null>(r => {
        resolve = r
    })
    return { promise, resolve }
}

function setUp() {
    const onMove = vi.fn()
    const hook = renderHook(() => useCanvasDrag({ getOrder: () => order, onMove }))
    for (const [key, { page: _page, ...rect }] of cells)
        act(() => hook.result.current.cellLayout(key, rect))
    for (const [key, rect] of pages) act(() => hook.result.current.pageLayout(key, rect))
    return { onMove, hook }
}

describe('useCanvasDrag', () => {
    it('ignores hovers until the drag-start measurement completes', async () => {
        const { hook } = setUp()
        const pending = deferred()
        act(() => {
            hook.result.current.registerCell('a', () => pending.promise)
        })
        act(() => hook.result.current.begin('c'))
        act(() => hook.result.current.hover({ x: 20, y: 120 }))
        expect(hook.result.current.dropTarget).toBeNull()
        // a was measured onto the second page's row.
        await act(async () => pending.resolve({ x: 0, y: 100, width: 100, height: 40 }))
        act(() => hook.result.current.hover({ x: 20, y: 120 }))
        expect(hook.result.current.dropTarget).toEqual({ key: 'a', side: 'before' })
    })

    it('waits for the measurement when the drop comes before it', async () => {
        const { hook, onMove } = setUp()
        const pending = deferred()
        act(() => {
            hook.result.current.registerCell('b', () => pending.promise)
        })
        act(() => hook.result.current.begin('a'))
        act(() => hook.result.current.drop('a', { x: 80, y: 120 }))
        expect(onMove).not.toHaveBeenCalled()
        // b was measured onto the second page's row; the drop lands after it.
        await act(async () => pending.resolve({ x: 0, y: 100, width: 100, height: 40 }))
        expect(onMove).toHaveBeenCalledWith('a', 'p1', 1)
        expect(hook.result.current.draggingKey).toBeNull()
    })

    // A drag starts in one event and moves in later ones, so the start's measurement settles first.
    const begin = (hook: ReturnType<typeof setUp>['hook'], key: string) =>
        act(async () => hook.result.current.begin(key))

    it('does not move a field dropped on the slot it already holds', async () => {
        const { hook, onMove } = setUp()
        await begin(hook, 'b')
        act(() => hook.result.current.drop('b', { x: 80, y: 20 }))
        await begin(hook, 'b')
        act(() => hook.result.current.drop('b', { x: 150, y: 20 }))
        expect(onMove).not.toHaveBeenCalled()
        await begin(hook, 'b')
        act(() => hook.result.current.drop('b', { x: 20, y: 20 }))
        expect(onMove).toHaveBeenCalledWith('b', 'p1', 0)
    })

    it('clears the drag on cancel without moving anything', async () => {
        const { hook, onMove } = setUp()
        await begin(hook, 'a')
        act(() => hook.result.current.hover({ x: 20, y: 120 }))
        expect(hook.result.current.dropTarget).toEqual({ key: 'c', side: 'before' })
        act(() => hook.result.current.cancel())
        expect(hook.result.current.draggingKey).toBeNull()
        expect(hook.result.current.dropTarget).toBeNull()
        expect(onMove).not.toHaveBeenCalled()
    })

    it('forgets a cell whose measure was unregistered', () => {
        const { hook } = setUp()
        let unregister = () => {}
        act(() => {
            unregister = hook.result.current.registerCell('a', async () => null)
        })
        act(() => unregister())
        act(() => hook.result.current.hover({ x: 20, y: 20 }))
        expect(hook.result.current.dropTarget).toEqual({ page: 'p1', end: true })
    })
})
