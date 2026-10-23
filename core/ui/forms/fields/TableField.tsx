import type { HostTableColumn } from '@tinycld/core/lib/forms/definition'
import type {
    BuiltinFieldProps,
    FieldMode,
    FormHostUi,
    TableCellContext,
} from '@tinycld/core/lib/forms/host-ui'
import type { FormValues } from '@tinycld/core/lib/forms/logic'
import type { TableRow } from '@tinycld/core/lib/forms/values'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import {
    ButtonGroup,
    type Control,
    Controller,
    NumberInput,
    TextInput,
    Toggle,
    useController,
} from '@tinycld/core/ui/form'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react-native'
import type { ComponentType } from 'react'
import type { UseFormGetValues } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { NARROW_BELOW } from '../widths'
import { DateField } from './DateField'
import { formatComputed } from './format-computed'
import { ADD_BUTTON, buttonKey, type TableFieldApi, useTableField } from './use-table-field'

export interface TableFieldProps {
    ui: FormHostUi | null
    name: string
    label: string
    columns: readonly HostTableColumn[]
    control: Control<FormValues>
    getValues: UseFormGetValues<FormValues>
    mode: FieldMode
    recordId?: string
    containerWidth: number
    computedRows: unknown
    /** A host table: on a record, an absent value means its rows have not loaded. */
    isHostTable: boolean
    testID: string
}

/** What every part of one table shares. */
interface TableBase {
    ui: FormHostUi | null
    name: string
    control: Control<FormValues>
    mode: FieldMode
    recordId?: string
    isEditable: boolean
    /** Prefix of every testID in the table. */
    ids: string
}

interface CellProps {
    base: TableBase
    table: TableFieldApi
    column: HostTableColumn
    row: TableRow
    index: number
}

interface RowProps {
    base: TableBase
    table: TableFieldApi
    columns: readonly HostTableColumn[]
    row: TableRow
    index: number
    count: number
}

const headerText = (c: HostTableColumn) => (c.required ? `${c.label} *` : c.label)

function CellError({ message }: { message?: string }) {
    if (!message) return null
    return <Text className="text-xs text-danger mt-1">{message}</Text>
}

function DateCell({
    control,
    name,
    disabled,
    testID,
    label,
}: {
    control: Control<FormValues>
    name: string
    disabled: boolean
    testID: string
    label: string
}) {
    const { field, fieldState } = useController({ control, name })
    const value = typeof field.value === 'string' ? field.value : null
    return (
        <View>
            <DateField
                value={value}
                onChange={field.onChange}
                withTime={false}
                disabled={disabled}
                testID={testID}
                accessibilityLabel={label}
            />
            <CellError message={fieldState.error?.message} />
        </View>
    )
}

function ComputedCell({
    value,
    decimals,
    testID,
    label,
}: {
    value: unknown
    decimals: number
    testID: string
    label: string
}) {
    const text = formatComputed(value, decimals)
    const tone = text ? 'text-foreground' : 'text-muted-foreground'
    return (
        <Text testID={testID} accessibilityLabel={label} className={`py-2 text-right ${tone}`}>
            {text || '—'}
        </Text>
    )
}

/** The host's component for a column; never on the design canvas, which has no rows to draw. */
function hostCellOf(base: TableBase, column: HostTableColumn) {
    if (base.mode === 'design' || !column.component) return undefined
    return base.ui?.components[column.component]
}

function HostCell({
    Component,
    label,
    base,
    table,
    column,
    row,
    index,
}: CellProps & { Component: ComponentType<BuiltinFieldProps>; label: string }) {
    const context: TableCellContext = {
        columnKey: column.key,
        rowIndex: index,
        row: table.computedRowOf(row),
        onRowChange: cells => table.onRowChange(row.id, cells),
    }
    return (
        <Controller
            control={base.control}
            name={`${base.name}.${index}.${column.key}`}
            render={({ field, fieldState }) => (
                <View>
                    <Component
                        fieldKey={base.name}
                        label={label}
                        recordId={base.recordId}
                        value={field.value}
                        onChange={field.onChange}
                        mode={base.mode}
                        disabled={!base.isEditable}
                        table={context}
                    />
                    <CellError message={fieldState.error?.message} />
                </View>
            )}
        />
    )
}

function CellInput(props: CellProps) {
    const { base, table, column, row, index } = props
    const name = `${base.name}.${index}.${column.key}`
    const testID = `${base.ids}-${row.id}-${column.key}`
    const label = `${column.label}, row ${index + 1}`
    const disabled = !base.isEditable
    const Host = hostCellOf(base, column)
    if (Host) return <HostCell {...props} Component={Host} label={label} />
    switch (column.kind) {
        case 'text':
            return (
                <TextInput
                    control={base.control}
                    name={name}
                    editable={!disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )
        case 'number':
            return (
                <NumberInput
                    control={base.control}
                    name={name}
                    min={column.min}
                    max={column.max}
                    allowDecimal
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )
        case 'toggle':
            return (
                <Toggle
                    control={base.control}
                    name={name}
                    label={label}
                    hideLabel
                    disabled={disabled}
                    wrapperProps={{ testID }}
                />
            )
        case 'date':
            return (
                <DateCell
                    control={base.control}
                    name={name}
                    disabled={disabled}
                    testID={testID}
                    label={label}
                />
            )
        case 'select':
            return (
                <ButtonGroup
                    control={base.control}
                    name={name}
                    label={label}
                    hideLabel
                    options={column.options}
                    horizontal
                    disabled={disabled}
                    wrapperProps={{ testID }}
                />
            )
        case 'computed':
            return (
                <ComputedCell
                    value={table.computedRowOf(row)[column.key]}
                    decimals={column.decimals}
                    testID={testID}
                    label={label}
                />
            )
    }
}

interface IconButtonProps {
    icon: ComponentType<{ size: number; color: string }>
    label: string
    isDisabled?: boolean
    onPress: () => void
    buttonRef: ReturnType<TableFieldApi['refFor']>
    testID: string
}

function IconButton({
    icon: Icon,
    label,
    isDisabled = false,
    onPress,
    buttonRef,
    testID,
}: IconButtonProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    return (
        <Pressable
            ref={buttonRef}
            onPress={onPress}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: isDisabled }}
            className="p-1.5 rounded-md"
            testID={testID}
        >
            <Icon size={16} color={isDisabled ? muted : fg} />
        </Pressable>
    )
}

/** Move up, Move down and Remove: buttons, so Tab + Enter/Space and screen readers reach them. */
function RowActions({ base, table, row, index, count }: RowProps) {
    if (!base.isEditable) return null
    const n = index + 1
    const prefix = `${base.ids}-${row.id}`
    return (
        <View className="w-24 flex-row items-center justify-end">
            <IconButton
                icon={ArrowUp}
                label={`Move row ${n} up`}
                isDisabled={index === 0}
                onPress={() => table.move(row.id, -1)}
                buttonRef={table.refFor(buttonKey(row.id, 'up'))}
                testID={`${prefix}-up`}
            />
            <IconButton
                icon={ArrowDown}
                label={`Move row ${n} down`}
                isDisabled={index === count - 1}
                onPress={() => table.move(row.id, 1)}
                buttonRef={table.refFor(buttonKey(row.id, 'down'))}
                testID={`${prefix}-down`}
            />
            <IconButton
                icon={Trash2}
                label={`Remove row ${n}`}
                onPress={() => table.remove(row.id)}
                buttonRef={table.refFor(buttonKey(row.id, 'remove'))}
                testID={`${prefix}-remove`}
            />
        </View>
    )
}

function ActionsSpacer({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return <View className="w-24" />
}

function GridHeader({
    base,
    columns,
    isVisible,
}: {
    base: TableBase
    columns: readonly HostTableColumn[]
    isVisible: boolean
}) {
    if (!isVisible) return null
    const cells = columns.map(c => (
        <Text
            key={c.key}
            testID={`${base.ids}-head-${c.key}`}
            className="flex-1 px-1 text-xs font-semibold text-muted-foreground"
        >
            {headerText(c)}
        </Text>
    ))
    return (
        <View className="flex-row gap-2 pb-1 border-b border-border">
            {cells}
            <ActionsSpacer isVisible={base.isEditable} />
        </View>
    )
}

function GridRow(props: RowProps) {
    const { base, table, columns, row, index } = props
    const cells = columns.map(column => (
        <View key={column.key} className="flex-1 min-w-0">
            <CellInput base={base} table={table} column={column} row={row} index={index} />
        </View>
    ))
    return (
        <View
            testID={`${base.ids}-row-${row.id}`}
            className="flex-row items-start gap-2 py-1 border-b border-border"
        >
            {cells}
            <RowActions {...props} />
        </View>
    )
}

/** A toggle and a choice list draw their own label, so a card does not repeat it. */
const drawsOwnLabel = (c: HostTableColumn) => c.kind === 'toggle' || c.kind === 'select'

function CardLabel({ text }: { text: string | null }) {
    if (!text) return null
    return <Text className="text-xs font-semibold text-muted-foreground mb-1">{text}</Text>
}

function CardCell(props: CellProps) {
    const label = drawsOwnLabel(props.column) ? null : headerText(props.column)
    return (
        <View className="mb-2">
            <CardLabel text={label} />
            <CellInput {...props} />
        </View>
    )
}

function CardRow(props: RowProps) {
    const { base, table, columns, row, index } = props
    const cells = columns.map(column => (
        <CardCell
            key={column.key}
            base={base}
            table={table}
            column={column}
            row={row}
            index={index}
        />
    ))
    return (
        <View
            testID={`${base.ids}-row-${row.id}`}
            accessibilityLabel={`Row ${index + 1}`}
            className="rounded-md border border-border p-3 mb-2"
        >
            {cells}
            <View className="flex-row justify-end">
                <RowActions {...props} />
            </View>
        </View>
    )
}

function PendingRows({ testID }: { testID: string }) {
    return (
        <Text testID={testID} className="text-sm text-muted-foreground py-2">
            Loading rows…
        </Text>
    )
}

function Rows({
    base,
    table,
    columns,
    isNarrow,
}: {
    base: TableBase
    table: TableFieldApi
    columns: readonly HostTableColumn[]
    isNarrow: boolean
}) {
    const Row = isNarrow ? CardRow : GridRow
    const layoutID = isNarrow ? `${base.ids}-cards` : `${base.ids}-grid`
    const count = table.rows.length
    const items = table.rows.map((row, index) => (
        <Row
            key={row.id}
            base={base}
            table={table}
            columns={columns}
            row={row}
            index={index}
            count={count}
        />
    ))
    return <View testID={layoutID}>{items}</View>
}

function EmptyRows({ isVisible, testID }: { isVisible: boolean; testID: string }) {
    if (!isVisible) return null
    return (
        <Text testID={testID} className="text-sm text-muted-foreground py-2">
            No rows yet.
        </Text>
    )
}

function AddRowButton({
    isVisible,
    onPress,
    buttonRef,
    testID,
}: {
    isVisible: boolean
    onPress: () => void
    buttonRef: ReturnType<TableFieldApi['refFor']>
    testID: string
}) {
    const fg = useThemeColor('foreground')
    if (!isVisible) return null
    return (
        <Pressable
            ref={buttonRef}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel="Add row"
            testID={testID}
            className="flex-row items-center gap-1 self-start mt-2 px-2 py-1 rounded-md border border-border"
        >
            <Plus size={16} color={fg} />
            <Text className="text-sm text-foreground">Add row</Text>
        </Pressable>
    )
}

export function TableField(props: TableFieldProps) {
    const { mode, name } = props
    const isEditable = mode === 'create' || mode === 'edit'
    const table = useTableField({
        control: props.control,
        getValues: props.getValues,
        name,
        columns: props.columns,
        computedRows: props.computedRows,
        isPendingWhenAbsent: props.isHostTable && (mode === 'edit' || mode === 'read'),
    })
    const base: TableBase = {
        ui: props.ui,
        name,
        control: props.control,
        mode,
        recordId: props.recordId,
        isEditable,
        ids: `form-table-${name}`,
    }
    const columns = props.columns.filter(c => !c.hidden)
    // 0 means not measured yet: lay out wide, as FieldCell does.
    const isNarrow = props.containerWidth > 0 && props.containerWidth < NARROW_BELOW
    if (table.isPending) return <PendingRows testID={`${base.ids}-pending`} />
    return (
        <View testID={props.testID} accessibilityLabel={props.label}>
            <GridHeader base={base} columns={columns} isVisible={!isNarrow} />
            <Rows base={base} table={table} columns={columns} isNarrow={isNarrow} />
            <EmptyRows isVisible={table.rows.length === 0} testID={`${base.ids}-empty`} />
            <AddRowButton
                isVisible={isEditable}
                onPress={table.add}
                buttonRef={table.refFor(ADD_BUTTON)}
                testID={`${base.ids}-add`}
            />
        </View>
    )
}
