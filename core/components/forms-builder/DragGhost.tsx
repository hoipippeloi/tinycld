import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useMeasuredRect } from '@tinycld/core/ui/forms/use-measure-rect'
import { GripVertical } from 'lucide-react-native'
import { useState, useSyncExternalStore } from 'react'
import { Text, View } from 'react-native'
import type { CanvasDrag, Point } from './use-canvas-drag'

// The chip sits right of and below the pointer, so the cursor never covers its label.
const OFFSET = { x: 12, y: 8 }

export interface DragGhostProps {
    drag: CanvasDrag
    /** The dragged field's label. */
    label: string
}

/**
 * A chip with the dragged field's label that follows the pointer. It is
 * drawn over the whole editor, outside the canvas's scroll view, so it is
 * never clipped. The overlay measures itself when it mounts (the drag's
 * start) and converts the pointer's window position into its own frame; the
 * pointer comes from the drag's store, so a move re-renders the chip alone.
 */
export function DragGhost({ drag, label }: DragGhostProps) {
    if (!drag.draggingKey) return null
    return <Overlay drag={drag} label={label} />
}

export function chipPosition(pointer: Point | null, origin: Point | null): Point | null {
    if (!pointer || !origin) return null
    return { x: pointer.x - origin.x + OFFSET.x, y: pointer.y - origin.y + OFFSET.y }
}

function Overlay({ drag, label }: DragGhostProps) {
    // The overlay's window origin, known once it has laid out.
    const [origin, setOrigin] = useState<Point | null>(null)
    const { ref, onLayout } = useMeasuredRect(rect => setOrigin({ x: rect.x, y: rect.y }))
    const pointer = useSyncExternalStore(drag.pointer.subscribe, drag.pointer.get, drag.pointer.get)
    return (
        <View
            ref={ref}
            onLayout={onLayout}
            pointerEvents="none"
            className="absolute inset-0"
            testID="form-drag-overlay"
        >
            <Chip label={label} at={chipPosition(pointer, origin)} />
        </View>
    )
}

function Chip({ label, at }: { label: string; at: Point | null }) {
    const muted = useThemeColor('muted-foreground')
    if (!at) return null
    return (
        <View
            className="absolute flex-row items-center gap-1 rounded-md border border-border bg-background px-2 py-1 shadow-md"
            style={{ left: at.x, top: at.y }}
            testID="form-drag-ghost"
        >
            <GripVertical size={14} color={muted} />
            <Text className="text-foreground text-sm font-medium" numberOfLines={1}>
                {label}
            </Text>
        </View>
    )
}
