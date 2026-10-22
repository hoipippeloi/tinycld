import type { TableColumn } from '@tinycld/core/lib/forms/definition'
import type { FormValues } from '@tinycld/core/lib/forms/logic'
import { moveRow, newTableRow } from '@tinycld/core/lib/forms/table-rows'
import type { TableRow } from '@tinycld/core/lib/forms/values'
import { newRecordId } from 'pbtsdb/core'
import { useRef } from 'react'
import { type Control, useController, useWatch } from 'react-hook-form'

export type RowButton = 'up' | 'down' | 'remove'
/** The Add row button among the focus targets; a row key always contains the row id first. */
export const ADD_BUTTON = ':add'
export const buttonKey = (rowId: string, button: RowButton) => `${rowId}:${button}`

/** What a focus target needs: a pressable's host instance on web and native. */
interface Focusable {
    focus: () => void
}

export interface UseTableFieldInput {
    control: Control<FormValues>
    name: string
    columns: readonly TableColumn[]
    /** This table's rows in the live computed values, computed cells filled. */
    computedRows: unknown
    /** True where an absent value means the host has not loaded the rows yet. */
    isPendingWhenAbsent: boolean
}

function asRows(value: unknown): TableRow[] | undefined {
    return Array.isArray(value) ? (value as TableRow[]) : undefined
}

export function useTableField(input: UseTableFieldInput) {
    const { control, name, columns, computedRows, isPendingWhenAbsent } = input
    const { field } = useController({ control, name })
    // Not exact, unlike the controller's own value: a cell edit (`lines.0.qty`)
    // must refresh the rows read here, or the next move would write the old cell back.
    const watched = useWatch({ control, name })
    const rows = asRows(watched) ?? []
    const computedById = new Map((asRows(computedRows) ?? []).map(r => [r.id, r] as const))
    const targets = useRef(new Map<string, Focusable>())

    const refFor = (key: string) => (el: Focusable | null) => {
        if (el) targets.current.set(key, el)
        else targets.current.delete(key)
    }
    // After the commit: React can re-insert a moved row's node, which drops its focus.
    const focusSoon = (key: string) => {
        requestAnimationFrame(() => targets.current.get(key)?.focus())
    }
    const add = () => field.onChange([...rows, newTableRow(columns, newRecordId())])
    const remove = (id: string) => {
        field.onChange(rows.filter(r => r.id !== id))
        focusSoon(ADD_BUTTON)
    }
    const move = (id: string, delta: -1 | 1) => {
        const next = moveRow(rows, id, delta)
        if (next === rows) return
        field.onChange(next)
        const index = next.findIndex(r => r.id === id)
        const atEdge = delta < 0 ? index === 0 : index === next.length - 1
        const same: RowButton = delta < 0 ? 'up' : 'down'
        const other: RowButton = delta < 0 ? 'down' : 'up'
        // At the top or bottom the same button is disabled, so focus takes the other one.
        focusSoon(buttonKey(id, atEdge ? other : same))
    }
    const onRowChange = (id: string, cells: Record<string, unknown>) =>
        field.onChange(rows.map(r => (r.id === id ? { ...r, ...cells } : r)))
    const computedRowOf = (row: TableRow) => computedById.get(row.id) ?? row

    return {
        rows,
        isPending: isPendingWhenAbsent && watched === undefined,
        add,
        remove,
        move,
        onRowChange,
        computedRowOf,
        refFor,
    }
}

export type TableFieldApi = ReturnType<typeof useTableField>
