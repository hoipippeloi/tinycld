import { newTableColumn, type TableColumnKind } from '@tinycld/core/lib/forms/builder'
import { TABLE_COLUMN_KINDS } from '@tinycld/core/lib/forms/definition'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { useFieldArray, useWatch } from '@tinycld/core/ui/form'
import { Menu } from '@tinycld/core/ui/menu'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react-native'
import type { ReactNode } from 'react'
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

/** A screen reader's name for a column: its place too, when another column has its label. */
function nameOf(label: string, index: number, labels: string[]) {
    const isShared = labels.filter(l => l === label).length > 1
    return isShared ? `${index + 1} (${label})` : label
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
    const [removingKey, setRemovingKey] = useState<string | null>(null)
    const count = array.fields.length
    const labels = array.fields.map((row, index) => (columns[index] ?? row).label)
    const rows = array.fields.map((row, index) => {
        const column = columns[index] ?? row
        const isOpen = column.key === openKey
        return {
            id: row.id,
            index,
            key: column.key,
            name: nameOf(column.label, index, labels),
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
            remove: () => setRemovingKey(column.key),
        }
    })
    const add = (label: string) => {
        if (!pendingKind) return
        const column = newTableColumn(pendingKind, label, new Set(columns.map(c => c.key)))
        array.append(column)
        setOpenKey(column.key)
        setPendingKind(null)
    }
    const removing = columns.find(c => c.key === removingKey)
    const confirmRemove = () => {
        const index = columns.findIndex(c => c.key === removingKey)
        setRemovingKey(null)
        if (index >= 0) array.remove(index)
    }
    return {
        rows,
        openKey,
        removingLabel: removing?.label ?? '',
        isRemoving: removing !== undefined,
        confirmRemove,
        cancelRemove: () => setRemovingKey(null),
        pendingKind,
        add,
        ask: setPendingKind,
        isAsking: pendingKind !== null,
        cancel: () => setPendingKind(null),
    }
}

type ColumnRowModel = ReturnType<typeof useColumns>['rows'][number]

function ColumnRow({ row, children }: { row: ColumnRowModel; children: ReactNode }) {
    const muted = useThemeColor('muted-foreground')
    const Chevron = row.isOpen ? ChevronDown : ChevronRight
    const frame = row.isOpen ? 'border-primary' : 'border-border'
    return (
        <View className={`rounded-md border mb-2 ${frame}`} testID={`form-column-${row.key}`}>
            <View className="flex-row items-center gap-1 px-2 py-1">
                <Pressable
                    onPress={row.toggle}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit column ${row.name}`}
                    accessibilityState={{ expanded: row.isOpen }}
                    className="flex-1 flex-row items-center gap-2 py-1"
                    testID={`form-column-${row.key}-edit`}
                >
                    <Chevron size={16} color={muted} />
                    <Text className="text-foreground font-medium">{row.title}</Text>
                    <Text className="text-xs text-muted-foreground">{row.kindLabel}</Text>
                </Pressable>
                <IconAction
                    icon={ChevronUp}
                    onPress={row.up}
                    isDisabled={!row.canUp}
                    label={`Move column ${row.name} up`}
                    testID={`form-column-${row.key}-up`}
                    className="p-2.5"
                />
                <IconAction
                    icon={ChevronDown}
                    onPress={row.down}
                    isDisabled={!row.canDown}
                    label={`Move column ${row.name} down`}
                    testID={`form-column-${row.key}-down`}
                    className="p-2.5"
                />
                <IconAction
                    icon={X}
                    onPress={row.remove}
                    isDisabled={!row.canRemove}
                    label={`Remove column ${row.name}`}
                    testID={`form-column-${row.key}-remove`}
                    className="p-2.5 ml-2"
                />
            </View>
            {children}
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

/** A custom table's columns: add, open, move and remove; the open one's settings unfold inside its own card. */
export function ColumnsEditor({ editor, fieldIndex }: ColumnsEditorProps) {
    const c = useColumns(editor, fieldIndex)
    const rows = c.rows.map(row => (
        <ColumnRow key={row.id} row={row}>
            <ColumnSettings
                key={row.key}
                editor={editor}
                fieldIndex={fieldIndex}
                columnIndex={row.index}
                isVisible={row.isOpen}
            />
        </ColumnRow>
    ))
    return (
        <View className="mb-3" testID="form-columns">
            <Text className="text-sm font-semibold text-foreground mb-1">Columns</Text>
            {rows}
            <AddColumn onPick={c.ask} />
            <ConfirmDialog
                isOpen={c.isRemoving}
                onClose={c.cancelRemove}
                onConfirm={c.confirmRemove}
                title="Remove column"
                message={`Remove the "${c.removingLabel}" column? A formula that uses it shows it as missing until you fix it.`}
                confirmLabel="Remove"
                isDestructive
                requiresServer={false}
            />
            <PromptDialog
                isOpen={c.isAsking}
                onClose={c.cancel}
                onSubmit={c.add}
                title={`Name the ${c.pendingKind ? COLUMN_KIND_LABELS[c.pendingKind].toLowerCase() : ''} column`}
                description="Formulas refer to it by this name. Its kind cannot be changed later."
                placeholder="Quantity"
                confirmLabel="Add"
                required
                maxLength={120}
                requiresServer={false}
            />
        </View>
    )
}
