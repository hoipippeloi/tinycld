import { columnOperands, type TableColumnKind } from '@tinycld/core/lib/forms/builder'
import { NumberInput, TextInput, Toggle, useWatch } from '@tinycld/core/ui/form'
import { Text, View } from 'react-native'
import { FormulaSettings } from './FormulaSettings'
import { OptionsEditor } from './OptionsEditor'
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

interface KindSettingsProps {
    editor: Editor
    at: `fields.${number}.columns.${number}`
    kind: TableColumnKind
    columnKey: string
    siblings: readonly { key: string; label: string; kind: string }[]
}

function ColumnKindSettings({ editor, at, kind, columnKey, siblings }: KindSettingsProps) {
    const { control } = editor.form
    switch (kind) {
        case 'text':
            return (
                <NumberInput
                    control={control}
                    name={`${at}.maxLength`}
                    label="Maximum length"
                    min={1}
                />
            )
        case 'number':
            return (
                <>
                    <NumberInput
                        control={control}
                        name={`${at}.min`}
                        label="Minimum"
                        allowDecimal
                    />
                    <NumberInput
                        control={control}
                        name={`${at}.max`}
                        label="Maximum"
                        allowDecimal
                    />
                </>
            )
        case 'select':
            return <OptionsEditor control={control} name={`${at}.options`} />
        case 'computed':
            return (
                <FormulaSettings
                    editor={editor}
                    name={`${at}.expression`}
                    decimalsName={`${at}.decimals`}
                    operands={columnOperands(siblings, columnKey)}
                    valueNoun="Column"
                    testID="form-column-formula"
                />
            )
        default:
            return null
    }
}

/** One column's settings, bound to the draft. Its key and kind are set when it is added, so they show as a footnote. */
export function ColumnSettings({
    editor,
    fieldIndex,
    columnIndex,
    isVisible,
}: ColumnSettingsProps) {
    const { control } = editor.form
    const at = `fields.${fieldIndex}.columns.${columnIndex}` as const
    const column = useWatch({ control, name: at })
    const siblings =
        useWatch({ control, name: `fields.${fieldIndex}.columns` as `fields.${number}.columns` }) ??
        []
    if (!isVisible || !column) return null
    return (
        <View className="gap-1 px-2 pb-3 pt-3 border-t border-border" testID="form-column-settings">
            <TextInput control={control} name={`${at}.label`} label="Label" />
            {/* A calculated cell is never typed in, so it cannot be required. */}
            <ColumnRequired
                editor={editor}
                name={`${at}.required`}
                isVisible={column.kind !== 'computed'}
            />
            <Toggle control={control} name={`${at}.hidden`} label="Hidden" />
            <ColumnKindSettings
                editor={editor}
                at={at}
                kind={column.kind}
                columnKey={column.key}
                siblings={siblings}
            />
            <View className="flex-row gap-3 pt-1">
                <Text className="text-xs text-muted-foreground" testID="form-column-kind">
                    {`${COLUMN_KIND_LABELS[column.kind]} column`}
                </Text>
                <Text className="text-xs text-muted-foreground" testID="form-column-key">
                    {`Key: ${column.key}`}
                </Text>
            </View>
        </View>
    )
}
