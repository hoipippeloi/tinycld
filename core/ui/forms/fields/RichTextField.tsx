import { useLazyEditor } from '@tinycld/core/components/editor/LazyEditor'
import { MarkdownRenderer } from '@tinycld/core/components/help/MarkdownRenderer'
import type { CollabDoc } from '@tinycld/core/lib/forms/host-ui'
import { Text, View } from 'react-native'

export interface RichTextFieldProps {
    fieldKey: string
    value: string | null
    onChange: (value: string) => void
    format: 'markdown' | 'html'
    /** Set in edit mode with a room; the field then binds to `fragment`. */
    collab?: CollabDoc | null
    fragment?: string
    disabled?: boolean
    testID?: string
}

// Core has no HTML renderer, so the read view shows the text content only.
function ReadView({ value, format }: { value: string; format: 'markdown' | 'html' }) {
    if (!value) return <Text className="text-muted-foreground">Empty</Text>
    if (format === 'markdown') return <MarkdownRenderer body={value} purpose="description" />
    return <Text className="text-foreground">{value.replace(/<[^>]+>/g, '')}</Text>
}

function collabOptionsFor(collab: CollabDoc | null | undefined, fragment: string | undefined) {
    if (!collab || !fragment) return undefined
    return {
        document: collab.doc,
        field: fragment,
        awareness: collab.awareness ?? undefined,
        user: collab.user ?? undefined,
    }
}

export function RichTextField({
    fieldKey,
    value,
    onChange,
    format,
    collab,
    fragment,
    disabled,
    testID,
}: RichTextFieldProps) {
    const collabOptions = collabOptionsFor(collab, fragment)
    const { body } = useLazyEditor({
        readView: <ReadView value={value ?? ''} format={format} />,
        value: value ?? '',
        contentFormat: format,
        editorOptions: { collab: collabOptions, placeholder: 'Write…', minHeight: 72 },
        surfaceId: `form:${fieldKey}`,
        // A collaborative field with no room must not take local edits that would diverge from the document.
        canEdit: !disabled && (fragment ? Boolean(collab?.canEdit) : true),
        // A collaborative document persists through the room, not the form value.
        onCommit: collabOptions ? () => {} : onChange,
        renderEditor: slots => <slots.EditorComponent />,
        testID,
        accessibilityLabel: 'Edit text',
    })
    return <View>{body}</View>
}
