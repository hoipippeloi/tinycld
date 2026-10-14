import type { FormPage } from '@tinycld/core/lib/forms/definition'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { PlainInput } from '@tinycld/core/ui/PlainInput'
import { Trash2 } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

export interface PageHeaderProps {
    page: FormPage
    canDelete: boolean
    deleteHint: string
    onRename: (title: string) => void
    onDelete: () => void
}

/**
 * Inline rename: the typed title stays local until blur or Enter, so the draft
 * never sees a half-typed or empty title. An empty title cancels.
 */
function useInlineRename(title: string, onRename: (title: string) => void) {
    const [draft, setDraft] = useState<string | null>(null)
    const commit = () => {
        const trimmed = draft?.trim()
        setDraft(null)
        if (!trimmed || trimmed === title) return
        onRename(trimmed)
    }
    return { value: draft ?? title, onChangeText: setDraft, commit }
}

function DeleteHint({ text, isVisible }: { text: string; isVisible: boolean }) {
    if (!isVisible) return null
    return <Text className="text-xs text-muted-foreground mr-1">{text}</Text>
}

export function PageHeader({ page, canDelete, deleteHint, onRename, onDelete }: PageHeaderProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const rename = useInlineRename(page.title, onRename)
    return (
        <View className="flex-row items-center mt-4 mb-2" testID={`form-page-header-${page.key}`}>
            <PlainInput
                value={rename.value}
                onChangeText={rename.onChangeText}
                onBlur={rename.commit}
                onSubmitEditing={rename.commit}
                accessibilityLabel="Page title"
                className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                testID={`form-page-title-${page.key}`}
            />
            <DeleteHint text={deleteHint} isVisible={!canDelete} />
            <Pressable
                onPress={onDelete}
                disabled={!canDelete}
                aria-disabled={canDelete ? undefined : true}
                accessibilityRole="button"
                accessibilityLabel={canDelete ? 'Delete page' : deleteHint}
                className="p-1"
                testID={`form-page-delete-${page.key}`}
            >
                <Trash2 size={16} color={canDelete ? fg : muted} />
            </Pressable>
        </View>
    )
}
