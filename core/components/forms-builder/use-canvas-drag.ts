import { useDragGesture } from '@tinycld/core/lib/gestures/use-drag-gesture'
import { log } from '@tinycld/core/lib/logger'
import type { MeasureRect } from '@tinycld/core/ui/forms/use-measure-rect'
import { useRef, useState } from 'react'
import { type NativeScrollEvent, type NativeSyntheticEvent, Platform } from 'react-native'

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
export interface Position {
    page: string
    index: number
}

const inside = (p: Point, r: Rect) =>
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** How far the pointer is from the rect on each axis; 0 within its span. */
function gapTo(p: Point, r: Rect) {
    return {
        dx: Math.max(r.x - p.x, 0, p.x - (r.x + r.width)),
        dy: Math.max(r.y - p.y, 0, p.y - (r.y + r.height)),
    }
}

/** Cells wrap into rows, so the nearer row wins first and the nearer cell in it second. */
function isNearer(p: Point, a: Rect, b: Rect) {
    const ga = gapTo(p, a)
    const gb = gapTo(p, b)
    return ga.dy !== gb.dy ? ga.dy < gb.dy : ga.dx < gb.dx
}

/**
 * A cell as wide as its page has its neighbours above and below, so its
 * midpoint is vertical; the cell draws its drop bars along its top and bottom
 * edges to match. A narrower cell has a neighbour beside it, so its midpoint
 * is horizontal.
 */
function isFullWidth(cell: Rect, pages: Map<string, Rect>): boolean {
    for (const page of pages.values()) {
        if (inside(centerOf(cell), page)) return cell.width >= page.width - 1
    }
    return false
}

/** Above or below a cell is its row's edge; over it, its midpoint along the axis its neighbours lie on. */
function sideOf(p: Point, r: Rect, isFull: boolean): 'before' | 'after' {
    if (p.y < r.y) return 'before'
    if (p.y > r.y + r.height) return 'after'
    const beforeMid = isFull ? p.y < r.y + r.height / 2 : p.x < r.x + r.width / 2
    return beforeMid ? 'before' : 'after'
}

/**
 * The slot under the pointer. Over a page but no cell (its header, its footer,
 * the margin between two cells) the nearest cell decides, so a field let go
 * above the first cell lands first; only below the page's last row is its end.
 */
export function findSlot(
    pointer: Point,
    cells: Map<string, Rect>,
    pages: Map<string, Rect>
): Slot | null {
    for (const [key, rect] of cells) {
        if (inside(pointer, rect)) {
            return { key, side: sideOf(pointer, rect, isFullWidth(rect, pages)) }
        }
    }
    for (const [page, rect] of pages) {
        if (!inside(pointer, rect)) continue
        const own = [...cells].filter(([, cell]) => inside(centerOf(cell), rect))
        if (own.every(([, cell]) => pointer.y > cell.y + cell.height)) return { page, end: true }
        const [key, cell] = own.reduce((best, next) =>
            isNearer(pointer, next[1], best[1]) ? next : best
        )
        return { key, side: sideOf(pointer, cell, isFullWidth(cell, pages)) }
    }
    return null
}

/** Two slots name the same landing place; used to leave the drop target alone while the pointer stays in it. */
export function sameSlot(a: Slot | null, b: Slot | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    if ('end' in a || 'end' in b) return 'end' in a && 'end' in b && a.page === b.page
    return a.key === b.key && a.side === b.side
}

/**
 * The pointer while a drag is live, outside React state: the ghost that
 * follows it subscribes here, so a move re-renders the ghost alone and not
 * the canvas.
 */
export function createPointerStore() {
    let pointer: Point | null = null
    const listeners = new Set<() => void>()
    return {
        get: () => pointer,
        set: (next: Point | null) => {
            pointer = next
            for (const listener of listeners) listener()
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
    }
}

export function shiftRects<R extends Rect>(map: Map<string, R>, offset: Point): Map<string, R> {
    const out = new Map<string, R>()
    for (const [key, rect] of map)
        out.set(key, { ...rect, x: rect.x + offset.x, y: rect.y + offset.y })
    return out
}

export function slotToPosition(slot: Slot, order: PageOrder[], dragging: string): Position {
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

/** Where a field sits now, in the same terms as `slotToPosition`. */
export function positionOf(key: string, order: PageOrder[]): Position | null {
    for (const o of order) {
        const index = o.keys.indexOf(key)
        if (index >= 0) return { page: o.page, index }
    }
    return null
}

export function orderOf(def: {
    pages: { key: string }[]
    fields: { key: string; page: string }[]
}): PageOrder[] {
    return def.pages.map(p => ({
        page: p.key,
        keys: def.fields.filter(f => f.page === p.key).map(f => f.key),
    }))
}

// A node that unmounted mid-measure never answers; without a limit the drag would never land.
const MEASURE_TIMEOUT_MS = 250

function measureWithin(measure: MeasureRect, ms: number): Promise<Rect | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ms)
    })
    return Promise.race([measure(), timeout]).finally(() => clearTimeout(timer))
}

function onlyKeys<R>(map: Map<string, R>, keys: Set<string>): Map<string, R> {
    return new Map([...map].filter(([key]) => keys.has(key)))
}

export interface UseCanvasDragOptions {
    /** Read at drop time, so a drag always lands against the current draft. */
    getOrder: () => PageOrder[]
    onMove: (key: string, page: string, index: number) => void
}

/**
 * Measured-slot drag: cells and pages report their window rects on layout
 * and register a thunk that re-measures them. Layout misses an element that
 * only moved, so a drag re-measures everything before it accepts a hover.
 * Rects are stored in scroll-independent coordinates (the scroll offset at
 * measurement is added back), so a canvas that scrolled after measuring still
 * hit-tests against where the cells are now.
 */
export function useCanvasDrag({ getOrder, onMove }: UseCanvasDragOptions) {
    const cells = useRef(new Map<string, Rect>())
    const pages = useRef(new Map<string, Rect>())
    const cellMeasures = useRef(new Map<string, MeasureRect>())
    const pageMeasures = useRef(new Map<string, MeasureRect>())
    const scroll = useRef<Point>({ x: 0, y: 0 })
    // Bumped when a drag starts or ends, so a measurement or drop from an
    // earlier drag cannot touch the current one.
    const session = useRef(0)
    const measuring = useRef<Promise<void> | null>(null)
    // Read by hover, which a late pointer event can call after the drag ended and
    // before React re-rendered; state would still say the drag is live.
    const active = useRef(false)
    const pointer = useRef(createPointerStore()).current
    // Drag position is transient UI state.
    const [draggingKey, setDraggingKey] = useState<string | null>(null)
    const [dropTarget, setDropTarget] = useState<Slot | null>(null)

    const unscrolled = (rect: Rect): Rect => ({
        ...rect,
        x: rect.x + scroll.current.x,
        y: rect.y + scroll.current.y,
    })
    const cellLayout = (key: string, rect: Rect) => cells.current.set(key, unscrolled(rect))
    const pageLayout = (key: string, rect: Rect) => pages.current.set(key, unscrolled(rect))
    const register =
        (measures: Map<string, MeasureRect>, rects: Map<string, Rect>) =>
        (key: string, measure: MeasureRect) => {
            measures.set(key, measure)
            return () => {
                if (measures.get(key) !== measure) return
                measures.delete(key)
                rects.delete(key)
            }
        }
    const registerCell = register(cellMeasures.current, cells.current)
    const registerPage = register(pageMeasures.current, pages.current)
    const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scroll.current = { ...e.nativeEvent.contentOffset }
    }

    const remeasure = async () => {
        const read = (measures: Map<string, MeasureRect>, rects: Map<string, Rect>) =>
            Promise.all(
                [...measures].map(async ([key, measure]) => {
                    const rect = await measureWithin(measure, MEASURE_TIMEOUT_MS)
                    if (rect) rects.set(key, unscrolled(rect))
                })
            )
        await Promise.all([
            read(cellMeasures.current, cells.current),
            read(pageMeasures.current, pages.current),
        ])
    }

    // A removed cell or page may keep its last rect; hit-test only what still exists.
    const slotAt = (pointer: Point) => {
        const order = getOrder()
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
        const order = getOrder()
        const target = slotToPosition(slot, order, key)
        const current = positionOf(key, order)
        if (current?.page === target.page && current.index === target.index) return
        onMove(key, target.page, target.index)
    }

    const end = () => {
        session.current += 1
        active.current = false
        measuring.current = null
        pointer.set(null)
        setDraggingKey(null)
        setDropTarget(null)
    }

    const begin = (key: string, at?: Point) => {
        session.current += 1
        const id = session.current
        active.current = true
        pointer.set(at ?? null)
        setDraggingKey(key)
        setDropTarget(null)
        const pending = remeasure()
            .catch(error => {
                // The rects from the last layout stay in place; the drag still works, less precisely.
                log.warn('forms.canvas', 're-measure on drag start failed', {
                    error: String(error),
                })
            })
            .finally(() => {
                if (session.current === id) measuring.current = null
            })
        measuring.current = pending
    }

    // The slot is replaced only when it changes, so the canvas re-renders
    // when the landing place moves and not on every pointer event.
    const hover = (at: Point) => {
        if (!active.current) return
        pointer.set(at)
        if (measuring.current) return
        const next = slotAt(at)
        setDropTarget(prev => (sameSlot(prev, next) ? prev : next))
    }

    const drop = (key: string, pointer: Point) => {
        const id = session.current
        const finish = () => {
            if (session.current !== id) return
            const slot = slotAt(pointer)
            if (slot) moveTo(key, slot)
            end()
        }
        const pending = measuring.current
        if (pending) void pending.then(finish)
        else finish()
    }

    return {
        cellLayout,
        pageLayout,
        registerCell,
        registerPage,
        onScroll,
        draggingKey,
        dropTarget,
        pointer,
        moveTo,
        begin,
        hover,
        drop,
        cancel: end,
    }
}

export type CanvasDrag = ReturnType<typeof useCanvasDrag>

/** Gesture handlers for one cell's drag handle. */
/**
 * On native a drag starts after a 250 ms hold, so a swipe that begins on a
 * handle still scrolls the canvas; web drags with a mouse or a pen at once.
 */
export const HANDLE_LONG_PRESS_MS = Platform.select({ native: 250 })

export function useDragHandle(drag: CanvasDrag, key: string) {
    return useDragGesture({
        longPressMs: HANDLE_LONG_PRESS_MS,
        onDragStart: ctx => {
            drag.begin(key, ctx.pointer)
            return true
        },
        onDragMove: ctx => drag.hover(ctx.pointer),
        onDragEnd: ctx => drag.drop(key, ctx.pointer),
        onDragCancel: () => drag.cancel(),
    })
}
