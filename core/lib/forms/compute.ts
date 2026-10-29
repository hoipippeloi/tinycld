import type { FormDefinition, TableColumn } from './definition'
import { type ComputeExpr, evalCompute, exprRefs, orderNodes, roundHalfAway } from './expression'
import { type FormHostDef, findBuiltin } from './host'
import type { FormValues } from './logic'

interface Node {
    expr: ComputeExpr
    decimals: number
}

function collect(def: FormDefinition, host: FormHostDef | undefined) {
    const nodes = new Map<string, Node>()
    const tables = new Map<string, TableColumn[]>()
    const hostTables = new Set<string>()
    for (const f of def.fields) {
        if (f.kind === 'computed') nodes.set(f.key, { expr: f.expression, decimals: f.decimals })
        else if (f.kind === 'table') tables.set(f.key, f.columns)
        else if (f.kind === 'builtin' && host) {
            const b = findBuiltin(host, f.key)
            if (b?.kind === 'computed' && b.expression !== undefined)
                nodes.set(f.key, { expr: b.expression, decimals: b.decimals })
            else if (b?.kind === 'table' && b.columns) {
                tables.set(f.key, b.columns)
                hostTables.add(f.key)
            }
        }
    }
    return { nodes, tables, hostTables }
}

function fillRow(columns: TableColumn[], row: unknown): unknown {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return row
    const nodes = new Map<string, Node>()
    const deps = new Map<string, string[]>()
    for (const c of columns) {
        if (c.kind !== 'computed') continue
        nodes.set(c.key, { expr: c.expression, decimals: c.decimals })
        deps.set(c.key, exprRefs(c.expression).vars)
    }
    const ordered = orderNodes(deps)
    if ('cycle' in ordered) return row
    const out: Record<string, unknown> = { ...row }
    for (const key of ordered.order) {
        const node = nodes.get(key)
        if (node) out[key] = roundHalfAway(evalCompute(node.expr, out), node.decimals)
    }
    return out
}

/**
 * Fills every table row's computed columns, then every computed field in
 * dependency order. Mirrored in Go (server/forms/compute.go). A custom table
 * lives in the record's own JSON, so when its value is absent or not a list it
 * has no rows. A host table's rows live in another collection: a computed
 * value that reads a host table missing from `values`, or reads another value
 * skipped for that reason, is left as it was, because the host computes it.
 */
export function applyComputed(
    def: FormDefinition,
    host: FormHostDef | undefined,
    values: FormValues
): FormValues {
    const { nodes, tables, hostTables } = collect(def, host)
    const out: FormValues = { ...values }
    for (const [key, columns] of tables) {
        const rows = out[key]
        if (Array.isArray(rows)) out[key] = rows.map(r => fillRow(columns, r))
    }
    const refs = new Map([...nodes].map(([key, node]) => [key, exprRefs(node.expr)] as const))
    const deps = new Map([...refs].map(([key, r]) => [key, r.vars] as const))
    const ordered = orderNodes(deps)
    // Validation rejects cycles, so one here means a stored definition predates the check.
    if ('cycle' in ordered) return out
    const skipped = new Set<string>()
    for (const key of ordered.order) {
        const node = nodes.get(key)
        const r = refs.get(key)
        if (!node || !r) continue
        const blocked =
            r.aggregates.some(a => hostTables.has(a.table) && !Array.isArray(out[a.table])) ||
            r.vars.some(v => skipped.has(v))
        if (blocked) {
            skipped.add(key)
            continue
        }
        out[key] = roundHalfAway(evalCompute(node.expr, out), node.decimals)
    }
    return out
}
