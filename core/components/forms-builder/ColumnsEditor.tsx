import { newTableColumn, type TableColumnKind } from '@tinycld/core/lib/forms/builder'
import { TABLE_COLUMN_KINDS } from '@tinycld/core/lib/forms/definition'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useFieldArray, useWatch } from '@tinycld/core/ui/form'
import { Menu } from '@tinycld/core/ui/menu'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { ChevronDown, ChevronUp, X } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { COLUMN_KIND_LABELS, ColumnSettings } from './ColumnSettings'
import { IconAction } from './OptionsEditor'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface ColumnsEditorProps {
    editor: Editor
    fieldIndex: number
}

function useColumns(editor: Editor, fieldIndex: number) {
    const { control } = editor.form
    // The path exists only on a table field; this editor mounts only for one.
    const name = `fields.${fieldIndex}.columns` as const
    const array = useFieldArray({ control, name })
    // Watched, because typed labels do not reach `array.fields`.
    const columns = useWatch({ control, name }) ?? []
    // The open column and the kind waiting for its label: local UI state.
    const [openKey, setOpenKey] = useState<string | null>(null)
    const [pendingKind, setPendingKind] = useState<TableColumnKind | null>(null)
    const count = array.fields.length
    const rows = array.fields.map((row, index) => {
        const column = columns[index] ?? row
        const isOpen = column.key === openKey
        return {
            id: row.id,
            key: column.key,
            label: column.label,
            title: column.required ? `${column.label} *` : column.label,
            kindLabel: COLUMN_KIND_LABELS[column.kind],
            isOpen,
            canUp: index > 0,
            canDown: index < count - 1,
            // A table needs a column.
            canRemove: count > 1,
            toggle: () => setOpenKey(isOpen ? null : column.key),
            up: () => array.move(index, index - 1),
            down: () => array.move(index, index + 1),
            remove: () => array.remove(index),
        }
    })
    const add = (label: string) => {
        if (!pendingKind) return
        const column = newTableColumn(pendingKind, label, new Set(columns.map(c => c.key)))
        array.append(column)
        setOpenKey(column.key)
        setPendingKind(null)
    }
    return {
        rows,
        openKey,
        openIndex: columns.findIndex(c => c.key === openKey),
        add,
        ask: setPendingKind,
        isAsking: pendingKind !== null,
        cancel: () => setPendingKind(null),
    }
}

type ColumnRowModel = ReturnType<typeof useColumns>['rows'][number]

function ColumnRow({ row }: { row: ColumnRowModel }) {
    return (
        <View className="flex-row items-center gap-2 py-1" testID={`form-column-${row.key}`}>
            <Pressable
                onPress={row.toggle}
                accessibilityRole="button"
                accessibilityLabel={`Edit column ${row.label}`}
                accessibilityState={{ expanded: row.isOpen }}
                className="flex-1"
                testID={`form-column-${row.key}-edit`}
            >
                <Text className="text-foreground">{row.title}</Text>
                <Text className="text-xs text-muted-foreground">{row.kindLabel}</Text>
            </Pressable>
            <IconAction
                icon={ChevronUp}
                onPress={row.up}
                isDisabled={!row.canUp}
                label={`Move column ${row.label} up`}
                testID={`form-column-${row.key}-up`}
                className="p-1"
            />
            <IconAction
                icon={ChevronDown}
                onPress={row.down}
                isDisabled={!row.canDown}
                label={`Move column ${row.label} down`}
                testID={`form-column-${row.key}-down`}
                className="p-1"
            />
            <IconAction
                icon={X}
                onPress={row.remove}
                isDisabled={!row.canRemove}
                label={`Remove column ${row.label}`}
                testID={`form-column-${row.key}-remove`}
                className="p-1"
            />
        </View>
    )
}

function AddColumn({ onPick }: { onPick: (kind: TableColumnKind) => void }) {
    const trigger = (
        <Button variant="outline" size="sm" className="self-start mt-1" testID="form-column-add">
            <ButtonText>Add column</ButtonText>
        </Button>
    )
    const items = TABLE_COLUMN_KINDS.map(kind => (
        <Menu.Item
            key={kind}
            label={COLUMN_KIND_LABELS[kind]}
            onSelect={() => onPick(kind)}
            testID={`form-column-kind-${kind}`}
        />
    ))
    return (
        <Menu presentation="auto" title="Add a column" trigger={trigger}>
            {items}
        </Menu>
    )
}

/** A custom table's columns: add, open, move and remove; the open one's settings below. */
export function ColumnsEditor({ editor, fieldIndex }: ColumnsEditorProps) {
    const c = useColumns(editor, fieldIndex)
    const rows = c.rows.map(row => <ColumnRow key={row.id} row={row} />)
    return (
        <View className="mb-3" testID="form-columns">
            <Text className="text-sm font-semibold text-foreground mb-1">Columns</Text>
            {rows}
            <AddColumn onPick={c.ask} />
            <ColumnSettings
                key={c.openKey ?? 'none'}
                editor={editor}
                fieldIndex={fieldIndex}
                columnIndex={c.openIndex}
                isVisible={c.openIndex >= 0}
            />
            <PromptDialog
                isOpen={c.isAsking}
                onClose={c.cancel}
                onSubmit={c.add}
                title="Column label"
                placeholder="Quantity"
                confirmLabel="Add"
                required
                maxLength={120}
                requiresServer={false}
            />
        </View>
    )
}
