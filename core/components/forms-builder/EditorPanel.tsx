import { useBreakpoint } from '@tinycld/core/components/workspace/useBreakpoint'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Sheet } from '@tinycld/core/ui/sheet'
import { X } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

export interface EditorPanelProps {
    isOpen: boolean
    onClose: () => void
    title: string
    children: ReactNode
}

/** Inline column beside the canvas on tablet and desktop; a bottom sheet on a phone. */
export function EditorPanel({ isOpen, onClose, title, children }: EditorPanelProps) {
    const isMobile = useBreakpoint() === 'mobile'
    const muted = useThemeColor('muted-foreground')
    if (isMobile) {
        return (
            <Sheet isOpen={isOpen} onClose={onClose} title={title} testID="form-panel-sheet">
                <Sheet.Body>{children}</Sheet.Body>
            </Sheet>
        )
    }
    if (!isOpen) return null
    return (
        <View className="w-[320px] border-l border-border pl-4" testID="form-panel">
            <View className="flex-row items-center justify-between mb-2">
                <Text className="text-base font-semibold text-foreground">{title}</Text>
                <Pressable
                    onPress={onClose}
                    accessibilityLabel="Close"
                    hitSlop={8}
                    testID="form-panel-close"
                >
                    <X size={16} color={muted} />
                </Pressable>
            </View>
            <ScrollView>{children}</ScrollView>
        </View>
    )
}
