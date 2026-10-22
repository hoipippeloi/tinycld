import type { TableColumnKind } from '@tinycld/core/lib/forms/builder'
import { TextInput, Toggle, useWatch } from '@tinycld/core/ui/form'
import { View } from 'react-native'
import { ReadOnlyRow } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export const COLUMN_KIND_LABELS: Record<TableColumnKind, string> = {
    text: 'Text',
    number: 'Number',
    toggle: 'Toggle',
    date: 'Date',
    select: 'Choice list',
    computed: 'Calculated',
}

export interface ColumnSettingsProps {
    editor: Editor
    fieldIndex: number
    /** The open column's index; -1 when none is open. */
    columnIndex: number
    isVisible: boolean
}

function ColumnRequired({
    editor,
    name,
    isVisible,
}: {
    editor: Editor
    name: `fields.${number}.columns.${number}.required`
    isVisible: boolean
}) {
    if (!isVisible) return null
    return <Toggle control={editor.form.control} name={name} label="Required" />
}

/** One column's settings, bound to the draft. Its key and kind are set when it is added. */
export function ColumnSettings({
    editor,
    fieldIndex,
    columnIndex,
    isVisible,
}: ColumnSettingsProps) {
    const { control } = editor.form
    const at = `fields.${fieldIndex}.columns.${columnIndex}` as const
    const column = useWatch({ control, name: at })
    if (!isVisible || !column) return null
    return (
        <View className="mt-2 p-3 rounded-md border border-border" testID="form-column-settings">
            <TextInput control={control} name={`${at}.label`} label="Label" />
            <ReadOnlyRow label="Key" value={column.key} testID="form-column-key" />
            <ReadOnlyRow
                label="Kind"
                value={COLUMN_KIND_LABELS[column.kind]}
                testID="form-column-kind"
            />
            {/* A calculated cell is never typed in, so it cannot be required. */}
            <ColumnRequired
                editor={editor}
                name={`${at}.required`}
                isVisible={column.kind !== 'computed'}
            />
            <Toggle control={control} name={`${at}.hidden`} label="Hidden" />
        </View>
    )
}
