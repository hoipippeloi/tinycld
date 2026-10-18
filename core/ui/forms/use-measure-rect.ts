import { useEffect, useRef } from 'react'
import type { View } from 'react-native'

export interface LayoutRect {
    x: number
    y: number
    width: number
    height: number
}

/** Measures the element's window rect now; null when it is not mounted or cannot be measured. */
export type MeasureRect = () => Promise<LayoutRect | null>

/** Registers a measure thunk; returns the unregister function. */
export type RegisterMeasure = (measure: MeasureRect) => () => void

/**
 * Window-coordinate measurement. `onRect` fires after layout; the builder
 * canvas hit-tests drops against these. `onLayout` does not fire when an
 * element only moves (react-native-web observes size, and native skips moved
 * ancestors), so `register` also hands out a thunk the canvas calls to
 * re-measure on demand at drag start.
 */
export function useMeasuredRect(onRect?: (rect: LayoutRect) => void, register?: RegisterMeasure) {
    const ref = useRef<View>(null)
    const onLayout = onRect
        ? () => {
              ref.current?.measureInWindow?.((x, y, width, height) =>
                  onRect({ x, y, width, height })
              )
          }
        : undefined
    // Registered once per mount: the thunk reads the ref when called, so it never goes stale.
    const registerRef = useRef(register)
    registerRef.current = register
    const isRegistering = Boolean(register)
    useEffect(() => {
        if (!isRegistering) return
        const measure: MeasureRect = () =>
            new Promise(resolve => {
                const node = ref.current
                if (!node?.measureInWindow) {
                    resolve(null)
                    return
                }
                node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }))
            })
        return registerRef.current?.(measure)
    }, [isRegistering])
    return { ref, onLayout }
}
