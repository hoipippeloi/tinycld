import { useRef } from 'react'
import type { View } from 'react-native'

export interface LayoutRect {
    x: number
    y: number
    width: number
    height: number
}

/** Window-coordinate measurement after layout; the builder canvas hit-tests drops against these. */
export function useMeasuredRect(onRect?: (rect: LayoutRect) => void) {
    const ref = useRef<View>(null)
    const onLayout = onRect
        ? () => {
              ref.current?.measureInWindow?.((x, y, width, height) =>
                  onRect({ x, y, width, height })
              )
          }
        : undefined
    return { ref, onLayout }
}
