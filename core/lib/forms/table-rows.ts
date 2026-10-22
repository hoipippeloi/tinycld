import type { TableColumn } from './definition'
import type { TableRow } from './values'

/**
 * How a host keeps a table built-in's rows (`storage: 'rows'`) in its own
 * collection. Core never writes those rows. The host reads its records into
 * table rows with `tableRowsOf`, hands them to `useFormEdit`, and writes the
 * plan `patch()` returns (or `planTableWrites([], rows)` on create), mapping
 * each row back with `toRecord`. Positions are dense indexes, 0 first: a host
 * that stores another numbering renumbers its rows before it relies on a plan.
 */
export interface TableRowMapper<R extends { id: string }, W = Partial<R>> {
    /** The row's cells, keyed by column key. The id always comes from the record. */
    toRow: (record: R) => Record<string, unknown>
    /** The record's sort key. */
    positionOf: (record: R) => number
    /** The fields to write for a row at a position. Never the id. */
    toRecord: (row: TableRow, position: number) => W
}

export function tableRowsOf<R extends { id: string }, W>(
    records: readonly R[],
    mapper: TableRowMapper<R, W>
): TableRow[] {
    return [...records]
        .sort((x, y) => mapper.positionOf(x) - mapper.positionOf(y) || (x.id < y.id ? -1 : 1))
        .map(record => ({ ...mapper.toRow(record), id: record.id }))
}

export interface TableRowWrite {
    row: TableRow
    position: number
}

export interface TableWritePlan {
    insert: TableRowWrite[]
    update: TableRowWrite[]
    remove: string[]
}

function sameCells(a: TableRow, b: TableRow): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false
    return true
}

/** What the host writes so its rows match `after`; a row's position is its index there. */
export function planTableWrites(
    before: readonly TableRow[],
    after: readonly TableRow[]
): TableWritePlan {
    const stored = new Map(before.map((row, position) => [row.id, { row, position }] as const))
    const plan: TableWritePlan = { insert: [], update: [], remove: [] }
    after.forEach((row, position) => {
        const old = stored.get(row.id)
        if (!old) plan.insert.push({ row, position })
        else if (old.position !== position || !sameCells(old.row, row))
            plan.update.push({ row, position })
    })
    const kept = new Set(after.map(row => row.id))
    plan.remove = before.filter(row => !kept.has(row.id)).map(row => row.id)
    return plan
}

/** A blank row: null in every editable column. Computed cells are the engine's. */
export function newTableRow(columns: readonly TableColumn[], id: string): TableRow {
    const row: TableRow = { id }
    for (const c of columns) if (c.kind !== 'computed') row[c.key] = null
    return row
}

/**
 * Every row with a value, maybe null, in every editable column, and a cleared
 * number (`''` from the number input) as null. A cell must never be absent:
 * react-hook-form fills an absent value from the default at the same index, so
 * a moved row would take its neighbour's value.
 */
export function completeTableRows(
    columns: readonly TableColumn[],
    rows: readonly TableRow[]
): TableRow[] {
    return rows.map(row => {
        const out: TableRow = { ...row }
        for (const c of columns) {
            if (c.kind === 'computed') continue
            const value = out[c.key]
            if (value === undefined || (c.kind === 'number' && value === '')) out[c.key] = null
        }
        return out
    })
}

export function moveRow(rows: TableRow[], id: string, delta: -1 | 1): TableRow[] {
    const from = rows.findIndex(r => r.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= rows.length) return rows
    const next = [...rows]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    return next
}
