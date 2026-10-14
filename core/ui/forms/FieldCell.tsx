import type { FieldWidth } from '@tinycld/core/lib/forms/definition'
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
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
}

// A border on both platforms; the border is always present so selecting a cell never shifts its layout.
const SELECTED_CLASS = 'border-primary'
const UNSELECTED_CLASS = 'border-transparent'

function RequiredMark({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return <Text className="text-destructive ml-0.5">*</Text>
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
}: FieldCellProps) {
    const basis = widthClass(effectiveWidth(width, containerWidth))
    const selection = isSelected ? SELECTED_CLASS : UNSELECTED_CLASS
    return (
        <View
            className={`${basis} grow-0 shrink-0 px-1.5 mb-3 rounded-md border-2 ${selection}`}
            testID={testID ?? `form-field-${fieldKey}`}
        >
            <View className="flex-row items-center mb-1">
                {handle}
                <Text
                    className="text-foreground text-sm font-medium"
                    nativeID={`form-label-${fieldKey}`}
                >
                    {label}
                </Text>
                <RequiredMark isVisible={required} />
            </View>
            <CellDescription text={description} />
            {children}
            <CellError message={error} />
        </View>
    )
}
