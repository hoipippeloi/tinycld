// @vitest-environment happy-dom

// The native hook drives a PanResponder. The test stub has none, so this one
// hands back the config: its callbacks are the handlers a test calls directly.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDragGesture } from './use-drag-gesture.native'

vi.mock('react-native', () => ({
    PanResponder: { create: (config: object) => ({ panHandlers: config }) },
}))

type Handler = (e: unknown, g?: unknown) => unknown
const handlersOf = (result: { current: { handlers: Record<string, unknown> } }) =>
    result.current.handlers as Record<string, Handler>
const event = (x: number, y: number) => ({ nativeEvent: { pageX: x, pageY: y } })
const moved = (dx: number, dy: number) => ({ dx, dy })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDragGesture (native)', () => {
    it('without longPressMs, engages on movement and yields the gesture when asked', () => {
        const onDragStart = vi.fn(() => true)
        const { result } = renderHook(() => useDragGesture({ onDragStart }))
        const h = handlersOf(result)
        act(() => {
            h.onPanResponderGrant(event(10, 10))
            h.onPanResponderMove(event(20, 10), moved(10, 0))
        })
        expect(onDragStart).toHaveBeenCalledTimes(1)
        expect(result.current.isDragging).toBe(true)
        expect(h.onPanResponderTerminationRequest(event(20, 10))).toBe(true)
    })

    it('with longPressMs, engages once the press is held that long', () => {
        const onDragStart = vi.fn(() => true)
        const onDragMove = vi.fn()
        const onDragEnd = vi.fn()
        const { result } = renderHook(() =>
            useDragGesture({ onDragStart, onDragMove, onDragEnd, longPressMs: 250 })
        )
        const h = handlersOf(result)
        act(() => {
            h.onPanResponderGrant(event(10, 10))
            h.onPanResponderMove(event(11, 10), moved(1, 0))
        })
        expect(onDragStart).not.toHaveBeenCalled()
        expect(h.onPanResponderTerminationRequest(event(11, 10))).toBe(true)
        act(() => {
            vi.advanceTimersByTime(250)
        })
        expect(onDragStart).toHaveBeenCalledTimes(1)
        expect(onDragStart).toHaveBeenCalledWith(
            expect.objectContaining({ pointer: expect.objectContaining({ x: 11, y: 10 }) })
        )
        expect(result.current.isDragging).toBe(true)
        // Engaged: a ScrollView asking for the gesture is refused.
        expect(h.onPanResponderTerminationRequest(event(11, 10))).toBe(false)
        act(() => {
            h.onPanResponderMove(event(40, 60), moved(30, 50))
            h.onPanResponderRelease(event(40, 60), moved(30, 50))
        })
        expect(onDragMove).toHaveBeenCalledTimes(1)
        expect(onDragEnd).toHaveBeenCalledTimes(1)
        expect(result.current.isDragging).toBe(false)
    })

    it('with longPressMs, a move past the threshold first gives the gesture up as a scroll', () => {
        const onDragStart = vi.fn(() => true)
        const onDragEnd = vi.fn()
        const { result } = renderHook(() =>
            useDragGesture({ onDragStart, onDragEnd, longPressMs: 250 })
        )
        const h = handlersOf(result)
        act(() => {
            h.onPanResponderGrant(event(10, 10))
            h.onPanResponderMove(event(10, 30), moved(0, 20))
            vi.advanceTimersByTime(500)
            h.onPanResponderMove(event(10, 60), moved(0, 50))
            h.onPanResponderRelease(event(10, 60), moved(0, 50))
        })
        expect(onDragStart).not.toHaveBeenCalled()
        expect(onDragEnd).not.toHaveBeenCalled()
        expect(result.current.isDragging).toBe(false)
    })

    it('with longPressMs, a release or a termination before the hold engages nothing', () => {
        const onDragStart = vi.fn(() => true)
        const onDragCancel = vi.fn()
        const { result } = renderHook(() =>
            useDragGesture({ onDragStart, onDragCancel, longPressMs: 250 })
        )
        const h = handlersOf(result)
        act(() => {
            h.onPanResponderGrant(event(10, 10))
            h.onPanResponderRelease(event(10, 10), moved(0, 0))
            h.onPanResponderGrant(event(10, 10))
            h.onPanResponderTerminate(event(10, 10), moved(0, 0))
            vi.advanceTimersByTime(500)
        })
        expect(onDragStart).not.toHaveBeenCalled()
        expect(onDragCancel).not.toHaveBeenCalled()
    })

    it('blocks the native responder only without longPressMs', () => {
        const plain = renderHook(() => useDragGesture({}))
        const held = renderHook(() => useDragGesture({ longPressMs: 250 }))
        expect(handlersOf(plain.result).onShouldBlockNativeResponder(event(0, 0))).toBe(true)
        expect(handlersOf(held.result).onShouldBlockNativeResponder(event(0, 0))).toBe(false)
    })

    it('clears the long-press timer on unmount', () => {
        const onDragStart = vi.fn(() => true)
        const { result, unmount } = renderHook(() =>
            useDragGesture({ onDragStart, longPressMs: 250 })
        )
        act(() => {
            handlersOf(result).onPanResponderGrant(event(10, 10))
        })
        unmount()
        act(() => {
            vi.advanceTimersByTime(500)
        })
        expect(onDragStart).not.toHaveBeenCalled()
    })
})
