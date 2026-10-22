import type { TableColumn } from '@tinycld/core/lib/forms/definition'
import type { FormValues } from '@tinycld/core/lib/forms/logic'
import { moveRow, newTableRow } from '@tinycld/core/lib/forms/table-rows'
import type { TableRow } from '@tinycld/core/lib/forms/values'
import { moveFocus } from '@tinycld/core/lib/move-focus'
import { newRecordId } from 'pbtsdb/core'
import { useRef } from 'react'
import { type Control, type UseFormGetValues, useController, useWatch } from 'react-hook-form'
import type { HostInstance } from 'react-native'

export type RowButton = 'up' | 'down' | 'remove'
/** The Add row button among the focus targets; a row key always contains the row id first. */
export const ADD_BUTTON = ':add'
export const buttonKey = (rowId: string, button: RowButton) => `${rowId}:${button}`

export interface UseTableFieldInput {
    control: Control<FormValues>
    /** Reads the form's values at call time; see `currentRows`. */
    getValues: UseFormGetValues<FormValues>
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
    const { control, getValues, name, columns, computedRows, isPendingWhenAbsent } = input
    const { field } = useController({ control, name })
    // Not exact, unlike the controller's own value: a cell edit (`lines.0.qty`)
    // must re-render the rows shown here.
    const watched = useWatch({ control, name })
    const rows = asRows(watched) ?? []
    const computedById = new Map((asRows(computedRows) ?? []).map(r => [r.id, r] as const))
    const targets = useRef(new Map<string, HostInstance>())
    const refs = useRef(new Map<string, (el: HostInstance | null) => void>())

    // Every write starts from the form's rows now, not this render's: a cell's
    // onChange earlier in the same handler, or a second press before the
    // re-render, has already changed them.
    const currentRows = () => asRows(getValues(name)) ?? []

    // One callback per key, so React does not detach and re-attach every ref on each render.
    const refFor = (key: string) => {
        const known = refs.current.get(key)
        if (known) return known
        const ref = (el: HostInstance | null) => {
            if (el) {
                targets.current.set(key, el)
                return
            }
            targets.current.delete(key)
            refs.current.delete(key)
        }
        refs.current.set(key, ref)
        return ref
    }
    // After the commit: React can re-insert a moved row's node, which drops its focus.
    const focusSoon = (key: string) => {
        requestAnimationFrame(() => {
            const target = targets.current.get(key)
            if (target) moveFocus(target)
        })
    }
    const add = () => field.onChange([...currentRows(), newTableRow(columns, newRecordId())])
    const remove = (id: string) => {
        field.onChange(currentRows().filter(r => r.id !== id))
        focusSoon(ADD_BUTTON)
    }
    const move = (id: string, delta: -1 | 1) => {
        const before = currentRows()
        const next = moveRow(before, id, delta)
        if (next === before) return
        field.onChange(next)
        const index = next.findIndex(r => r.id === id)
        const atEdge = delta < 0 ? index === 0 : index === next.length - 1
        const same: RowButton = delta < 0 ? 'up' : 'down'
        const other: RowButton = delta < 0 ? 'down' : 'up'
        // At the top or bottom the same button is disabled, so focus takes the other one.
        focusSoon(buttonKey(id, atEdge ? other : same))
    }
    const onRowChange = (id: string, cells: Record<string, unknown>) =>
        field.onChange(currentRows().map(r => (r.id === id ? { ...r, ...cells } : r)))
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
