import type { ReactNode } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'

export interface FormLayoutProps {
    children: ReactNode
    onLayout?: (e: LayoutChangeEvent) => void
    testID?: string
}

/** A wrapping row; each FieldCell sets its own basis. The negative margin cancels the cells' side padding. */
export function FormLayout({ children, onLayout, testID }: FormLayoutProps) {
    return (
        <View className="flex-row flex-wrap -mx-1.5" onLayout={onLayout} testID={testID}>
            {children}
        </View>
    )
}
