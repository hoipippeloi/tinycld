import { describe, expect, it } from 'vitest'
import { findSlot, shiftRects, slotToPosition } from '../use-canvas-drag'

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
