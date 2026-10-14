import { useMemo, useRef, useState } from 'react'
import {
    type GestureResponderEvent,
    PanResponder,
    type PanResponderGestureState,
} from 'react-native'
import type { DragContext, DragGestureHandlers, PointerLike, UseDragGestureOptions } from './types'

interface GestureState {
    startX: number
    startY: number
    startRect: { left: number; top: number; width: number; height: number } | null
    engaged: boolean
    gestureRefused: boolean
    // The last pointer position and movement, for a long press that
    // engages without a move event.
    lastX: number
    lastY: number
    dx: number
    dy: number
    pressTimer: ReturnType<typeof setTimeout> | null
}

function clearPressTimer(s: GestureState) {
    if (s.pressTimer !== null) clearTimeout(s.pressTimer)
    s.pressTimer = null
}

export function useDragGesture(opts: UseDragGestureOptions): DragGestureHandlers {
    const optsRef = useRef(opts)
    optsRef.current = opts

    const [isDragging, setIsDragging] = useState(false)
    const wasDraggedRef = useRef(false)
    const [, forceRender] = useState(0)

    const stateRef = useRef<GestureState | null>(null)

    // PanResponder is memoized per-mount so its closure captures the
    // ref-driven opts (which always read through optsRef.current). This
    // lets the consumer pass fresh closures each render without re-
    // creating the responder.
    const panResponder = useMemo(() => {
        // Crossing into a drag: onDragStart may still refuse it.
        const engage = (s: GestureState, ctx: DragContext) => {
            s.engaged = true
            setIsDragging(true)
            const accepted = optsRef.current.onDragStart?.(ctx) ?? true
            if (accepted === false) s.gestureRefused = true
        }
        return PanResponder.create({
            onStartShouldSetPanResponder: () => !optsRef.current.disabled,
            onStartShouldSetPanResponderCapture: () => !optsRef.current.disabled,
            onMoveShouldSetPanResponder: () => !optsRef.current.disabled,
            onMoveShouldSetPanResponderCapture: () => !optsRef.current.disabled,
            onPanResponderGrant: (e: GestureResponderEvent) => {
                wasDraggedRef.current = false
                const { pageX, pageY } = e.nativeEvent
                // startRect is null on native — RN doesn't surface
                // target dimensions in the gesture event. Consumers
                // that need the rect should set measureTarget=false
                // and compute their own geometry from a ref.
                const s: GestureState = {
                    startX: pageX,
                    startY: pageY,
                    startRect: null,
                    engaged: false,
                    gestureRefused: false,
                    lastX: pageX,
                    lastY: pageY,
                    dx: 0,
                    dy: 0,
                    pressTimer: null,
                }
                stateRef.current = s
                const longPressMs = optsRef.current.longPressMs
                if (longPressMs === undefined) return
                s.pressTimer = setTimeout(() => {
                    s.pressTimer = null
                    if (stateRef.current !== s || s.gestureRefused) return
                    engage(s, {
                        pointer: pointerAt(s.lastX, s.lastY),
                        deltaX: s.dx,
                        deltaY: s.dy,
                        startRect: s.startRect,
                    })
                }, longPressMs)
            },
            // Before a long press engages, a ScrollView may take the
            // gesture; after, the drag keeps it.
            onPanResponderTerminationRequest: () => {
                const s = stateRef.current
                return !(optsRef.current.longPressMs !== undefined && s?.engaged)
            },
            onPanResponderMove: (e: GestureResponderEvent, g: PanResponderGestureState) => {
                const s = stateRef.current
                if (s == null) return
                if (s.gestureRefused) return
                s.lastX = e.nativeEvent.pageX
                s.lastY = e.nativeEvent.pageY
                s.dx = g.dx
                s.dy = g.dy
                const threshold = optsRef.current.threshold ?? 3
                if (!s.engaged) {
                    if (Math.abs(g.dx) < threshold && Math.abs(g.dy) < threshold) return
                    // A long-press drag moved too soon: this gesture is a scroll, not a drag.
                    if (optsRef.current.longPressMs !== undefined) {
                        clearPressTimer(s)
                        s.gestureRefused = true
                        return
                    }
                    engage(s, {
                        pointer: pointerLikeFromGesture(e),
                        deltaX: g.dx,
                        deltaY: g.dy,
                        startRect: s.startRect,
                    })
                    return
                }
                const ctx: DragContext = {
                    pointer: pointerLikeFromGesture(e),
                    deltaX: g.dx,
                    deltaY: g.dy,
                    startRect: s.startRect,
                }
                optsRef.current.onDragMove?.(ctx)
            },
            onPanResponderRelease: (e: GestureResponderEvent, g: PanResponderGestureState) => {
                const s = stateRef.current
                if (s == null) return
                clearPressTimer(s)
                if (s.engaged && !s.gestureRefused) {
                    const ctx: DragContext = {
                        pointer: pointerLikeFromGesture(e),
                        deltaX: g.dx,
                        deltaY: g.dy,
                        startRect: s.startRect,
                    }
                    optsRef.current.onDragEnd?.(ctx)
                    wasDraggedRef.current = true
                    forceRender(n => n + 1)
                }
                stateRef.current = null
                setIsDragging(false)
            },
            onPanResponderTerminate: (e: GestureResponderEvent, g: PanResponderGestureState) => {
                const s = stateRef.current
                if (s) clearPressTimer(s)
                if (s?.engaged && !s.gestureRefused)
                    optsRef.current.onDragCancel?.({
                        pointer: pointerLikeFromGesture(e),
                        deltaX: g.dx,
                        deltaY: g.dy,
                        startRect: s.startRect,
                    })
                stateRef.current = null
                setIsDragging(false)
            },
        })
    }, [])

    return {
        handlers: panResponder.panHandlers as unknown as Record<string, unknown>,
        isDragging,
        wasDragged: wasDraggedRef.current,
    }
}

function pointerLikeFromGesture(e: GestureResponderEvent): PointerLike {
    return pointerAt(e.nativeEvent.pageX, e.nativeEvent.pageY)
}

function pointerAt(x: number, y: number): PointerLike {
    return {
        x,
        y,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
    }
}
