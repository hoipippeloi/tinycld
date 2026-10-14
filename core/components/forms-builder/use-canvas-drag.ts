import { useDragGesture } from '@tinycld/core/lib/gestures/use-drag-gesture'
import { useRef, useState } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

export interface Rect {
    x: number
    y: number
    width: number
    height: number
}
export interface Point {
    x: number
    y: number
}
export type Slot = { key: string; side: 'before' | 'after' } | { page: string; end: true }
export interface PageOrder {
    page: string
    keys: string[]
}
type CellRect = Rect & { page: string }

const inside = (p: Point, r: Rect) =>
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

export function findSlot(
    pointer: Point,
    cells: Map<string, CellRect>,
    pages: Map<string, Rect>
): Slot | null {
    for (const [key, rect] of cells) {
        if (inside(pointer, rect))
            return { key, side: pointer.x < rect.x + rect.width / 2 ? 'before' : 'after' }
    }
    for (const [page, rect] of pages) {
        if (inside(pointer, rect)) return { page, end: true }
    }
    return null
}

export function shiftRects<R extends Rect>(map: Map<string, R>, offset: Point): Map<string, R> {
    const out = new Map<string, R>()
    for (const [key, rect] of map)
        out.set(key, { ...rect, x: rect.x + offset.x, y: rect.y + offset.y })
    return out
}

export function slotToPosition(
    slot: Slot,
    order: PageOrder[],
    dragging: string
): { page: string; index: number } {
    if ('end' in slot) {
        const keys = order.find(o => o.page === slot.page)?.keys.filter(k => k !== dragging) ?? []
        return { page: slot.page, index: keys.length }
    }
    for (const o of order) {
        const keys = o.keys.filter(k => k !== dragging)
        const at = keys.indexOf(slot.key)
        if (at >= 0) return { page: o.page, index: slot.side === 'before' ? at : at + 1 }
    }
    return { page: order[0]?.page ?? '', index: 0 }
}

function onlyKeys<R>(map: Map<string, R>, keys: Set<string>): Map<string, R> {
    return new Map([...map].filter(([key]) => keys.has(key)))
}

export interface UseCanvasDragOptions {
    order: PageOrder[]
    onMove: (key: string, page: string, index: number) => void
}

/**
 * Measured-slot drag: cells and pages report their window rects; the pointer
 * picks the slot under it. Rects are stored in scroll-independent coordinates
 * (the scroll offset at measurement is added back), so a canvas that scrolled
 * after layout still hit-tests against where the cells are now.
 */
export function useCanvasDrag({ order, onMove }: UseCanvasDragOptions) {
    const cells = useRef(new Map<string, CellRect>())
    const pages = useRef(new Map<string, Rect>())
    const scroll = useRef<Point>({ x: 0, y: 0 })
    // Drag position is transient UI state.
    const [draggingKey, setDraggingKey] = useState<string | null>(null)
    const [dropTarget, setDropTarget] = useState<Slot | null>(null)

    const unscrolled = <R extends Rect>(rect: R): R => ({
        ...rect,
        x: rect.x + scroll.current.x,
        y: rect.y + scroll.current.y,
    })
    const cellLayout = (key: string, page: string, rect: Rect) =>
        cells.current.set(key, unscrolled({ ...rect, page }))
    const pageLayout = (key: string, rect: Rect) => pages.current.set(key, unscrolled(rect))
    const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scroll.current = { ...e.nativeEvent.contentOffset }
    }

    // A removed cell or page keeps its last rect in the maps; hit-test only what still exists.
    const slotAt = (pointer: Point) => {
        const keys = new Set(order.flatMap(o => o.keys))
        const pageKeys = new Set(order.map(o => o.page))
        const back = { x: -scroll.current.x, y: -scroll.current.y }
        return findSlot(
            pointer,
            shiftRects(onlyKeys(cells.current, keys), back),
            shiftRects(onlyKeys(pages.current, pageKeys), back)
        )
    }

    const moveTo = (key: string, slot: Slot) => {
        if ('key' in slot && slot.key === key) return
        const { page, index } = slotToPosition(slot, order, key)
        onMove(key, page, index)
    }

    const begin = (key: string) => setDraggingKey(key)
    const hover = (pointer: Point) => setDropTarget(slotAt(pointer))
    const drop = (key: string, pointer: Point) => {
        const slot = slotAt(pointer)
        if (slot) moveTo(key, slot)
        setDraggingKey(null)
        setDropTarget(null)
    }

    return {
        cellLayout,
        pageLayout,
        onScroll,
        draggingKey,
        dropTarget,
        moveTo,
        begin,
        hover,
        drop,
    }
}

export type CanvasDrag = ReturnType<typeof useCanvasDrag>

/** Gesture handlers for one cell's drag handle. */
export function useDragHandle(drag: CanvasDrag, key: string) {
    return useDragGesture({
        onDragStart: () => {
            drag.begin(key)
            return true
        },
        onDragMove: ctx => drag.hover(ctx.pointer),
        onDragEnd: ctx => drag.drop(key, ctx.pointer),
    })
}
