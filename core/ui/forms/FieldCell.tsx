import type { FieldWidth } from '@tinycld/core/lib/forms/definition'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { type LayoutRect, type RegisterMeasure, useMeasuredRect } from './use-measure-rect'
import { effectiveWidth, widthClass } from './widths'

export interface FieldCellProps {
    fieldKey: string
    label: string
    description?: string
    required: boolean
    error?: string
    width: FieldWidth
    containerWidth: number
    children: ReactNode
    testID?: string
    /** The builder's drag handle, rendered before the label. */
    handle?: ReactNode
    isSelected?: boolean
    /** The input shows the label itself (a toggle, a radio or choice list), so the cell does not. */
    hideLabel?: boolean
    /** The builder's per-cell marker (e.g. a rule badge), right of the label. */
    badge?: ReactNode
    /** Which edge shows the drop bar while a field is dragged over this cell. */
    dropIndicator?: 'before' | 'after'
    onLayoutRect?: (rect: LayoutRect) => void
    /** Hands the builder a thunk that re-measures this cell on demand. */
    registerMeasure?: RegisterMeasure
    /**
     * The builder selects the cell on press. The cell itself is then the
     * pressable, so it stays the row's flex item and keeps its width basis.
     */
    onPress?: () => void
}

// A border on both platforms; the border is always present so selecting a cell never shifts its layout.
const SELECTED_CLASS = 'border-primary'
const UNSELECTED_CLASS = 'border-transparent'

function RequiredMark({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return <Text className="text-destructive ml-0.5">*</Text>
}

function CellLabel({
    fieldKey,
    label,
    isVisible,
}: {
    fieldKey: string
    label: string
    isVisible: boolean
}) {
    if (!isVisible) return null
    return (
        <Text className="text-foreground text-sm font-medium" nativeID={`form-label-${fieldKey}`}>
            {label}
        </Text>
    )
}

function DropBar({ fieldKey, side }: { fieldKey: string; side?: 'before' | 'after' }) {
    if (!side) return null
    const edge = side === 'before' ? 'left-0' : 'right-0'
    return (
        <View
            className={`absolute top-0 bottom-0 w-0.5 bg-primary ${edge}`}
            testID={`form-field-${fieldKey}-drop-${side}`}
        />
    )
}

function CellError({ message }: { message?: string }) {
    if (!message) return null
    return (
        <Text className="text-destructive text-xs mt-1" accessibilityRole="alert">
            {message}
        </Text>
    )
}

function CellDescription({ text }: { text?: string }) {
    if (!text) return null
    return <Text className="text-muted-foreground text-xs mb-1">{text}</Text>
}

export function FieldCell({
    fieldKey,
    label,
    description,
    required,
    error,
    width,
    containerWidth,
    children,
    testID,
    handle,
    isSelected,
    hideLabel = false,
    badge,
    dropIndicator,
    onLayoutRect,
    registerMeasure,
    onPress,
}: FieldCellProps) {
    const basis = widthClass(effectiveWidth(width, containerWidth))
    const { ref, onLayout } = useMeasuredRect(onLayoutRect, registerMeasure)
    const selection = isSelected ? SELECTED_CLASS : UNSELECTED_CLASS
    const root = {
        ref,
        onLayout,
        className: `relative ${basis} grow-0 shrink-0 px-1.5 mb-3 rounded-md border-2 ${selection}`,
        testID: testID ?? `form-field-${fieldKey}`,
    }
    const body = (
        <>
            <View className="flex-row items-center mb-1">
                {handle}
                <CellLabel fieldKey={fieldKey} label={label} isVisible={!hideLabel} />
                <RequiredMark isVisible={required} />
                {badge}
            </View>
            <CellDescription text={description} />
            {children}
            <CellError message={error} />
            <DropBar fieldKey={fieldKey} side={dropIndicator} />
        </>
    )
    if (!onPress) return <View {...root}>{body}</View>
    return (
        <Pressable
            {...root}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Select ${label}`}
        >
            {body}
        </Pressable>
    )
}
