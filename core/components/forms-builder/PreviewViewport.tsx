import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'

// Below the renderer's NARROW_BELOW (640), so half and third cells collapse
// to full width and quarter to half, as they do on a real phone.
export const PHONE_WIDTH = 390

export type PreviewViewport = 'desktop' | 'phone'

interface ViewportOptionProps {
    label: string
    value: PreviewViewport
    current: PreviewViewport
    onChange: (value: PreviewViewport) => void
}

function ViewportOption({ label, value, current, onChange }: ViewportOptionProps) {
    const isSelected = value === current
    return (
        <Pressable
            accessibilityRole="radio"
            aria-checked={isSelected}
            accessibilityState={{ checked: isSelected }}
            onPress={() => onChange(value)}
            className={`px-3 py-1 ${isSelected ? 'bg-primary' : 'bg-background'}`}
            testID={`form-preview-${value}`}
        >
            <Text
                className={
                    isSelected ? 'text-primary-foreground text-sm' : 'text-foreground text-sm'
                }
            >
                {label}
            </Text>
        </Pressable>
    )
}

interface PreviewViewportToggleProps {
    value: PreviewViewport
    onChange: (value: PreviewViewport) => void
    isVisible: boolean
}

export function PreviewViewportToggle({ value, onChange, isVisible }: PreviewViewportToggleProps) {
    if (!isVisible) return null
    return (
        <View
            className="flex-row self-end rounded-md border border-border overflow-hidden mb-3"
            accessibilityRole="radiogroup"
        >
            <ViewportOption label="Desktop" value="desktop" current={value} onChange={onChange} />
            <ViewportOption label="Phone" value="phone" current={value} onChange={onChange} />
        </View>
    )
}

export function PreviewFrame({
    viewport,
    children,
}: {
    viewport: PreviewViewport
    children: ReactNode
}) {
    if (viewport === 'desktop') return <>{children}</>
    return (
        <View
            className="self-center border border-border rounded-xl p-4"
            style={{ width: PHONE_WIDTH }}
            testID="form-preview-viewport-phone"
        >
            {children}
        </View>
    )
}
