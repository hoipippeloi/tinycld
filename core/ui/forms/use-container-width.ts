import { useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'

/** Measured width of the form container. 0 until the first layout. Local UI state, so useState is right here. */
export function useContainerWidth() {
    const [width, setWidth] = useState(0)
    const onLayout = (e: LayoutChangeEvent) => {
        const next = Math.round(e.nativeEvent.layout.width)
        if (next !== width) setWidth(next)
    }
    return { width, onLayout }
}
