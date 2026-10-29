import { type ComputeExpr, exprRefs, orderNodes } from './expression'

/** What validation needs to know about a table column. */
export interface ComputeColumn {
    key: string
    kind: string
    expression?: ComputeExpr
}

/** What validation needs to know about a field. A 'builtin' kind means "unknown here, the host check resolves it". */
export interface ComputeField {
    key: string
    kind: string
    expression?: ComputeExpr
    columns?: ComputeColumn[]
}

export interface ComputeIssue {
    path: (string | number)[]
    message: string
}

const NUMERIC_KINDS = new Set(['number', 'computed', 'toggle'])
const SUMMABLE_COLUMN_KINDS = new Set(['number', 'computed'])

function columnIssues(field: ComputeField, path: (string | number)[]): ComputeIssue[] {
    const issues: ComputeIssue[] = []
    const columns = field.columns ?? []
    const kinds = new Map<string, string>()
    columns.forEach((c, i) => {
        const at = [...path, 'columns', i, 'key']
        if (c.key === 'id') issues.push({ path: at, message: 'id is reserved for the row id' })
        else if (kinds.has(c.key))
            issues.push({ path: at, message: `duplicate column key ${c.key}` })
        kinds.set(c.key, c.kind)
    })
    const deps = new Map<string, string[]>()
    columns.forEach((c, i) => {
        if (c.kind !== 'computed' || c.expression === undefined) return
        const at = [...path, 'columns', i, 'expression']
        const refs = exprRefs(c.expression)
        if (refs.aggregates.length > 0)
            issues.push({ path: at, message: 'a column formula cannot sum or count a table' })
        for (const v of refs.vars) {
            const kind = kinds.get(v)
            if (kind === undefined) issues.push({ path: at, message: `unknown column ${v}` })
            else if (!NUMERIC_KINDS.has(kind))
                issues.push({
                    path: at,
                    message: `${v} is a ${kind} column and cannot be used in a formula`,
                })
        }
        deps.set(c.key, refs.vars)
    })
    const ordered = orderNodes(deps)
    if ('cycle' in ordered) {
        const index = columns.findIndex(c => c.key === ordered.cycle[0])
        issues.push({
            path: [...path, 'columns', index, 'expression'],
            message: `formula cycle: ${ordered.cycle.join(' → ')}`,
        })
    }
    return issues
}

/**
 * Cross-field checks for formulas: every referenced field exists and is
 * numeric, aggregates point at a table's numeric column, columns reference
 * only siblings, and nothing depends on itself. Mirrored in Go
 * (server/forms/compute_validate.go). `base` is the path to the field list.
 */
export function computedIssues(fields: ComputeField[], base: (string | number)[]): ComputeIssue[] {
    const issues: ComputeIssue[] = []
    const byKey = new Map(fields.map(f => [f.key, f]))
    const deps = new Map<string, string[]>()
    fields.forEach((f, i) => {
        if (f.kind === 'table') issues.push(...columnIssues(f, [...base, i]))
        if (f.kind !== 'computed' || f.expression === undefined) return
        const at = [...base, i, 'expression']
        const refs = exprRefs(f.expression)
        for (const v of refs.vars) {
            const target = byKey.get(v)
            if (!target) issues.push({ path: at, message: `unknown field ${v}` })
            else if (target.kind !== 'builtin' && !NUMERIC_KINDS.has(target.kind))
                issues.push({
                    path: at,
                    message: `${v} is a ${target.kind} field and cannot be used in a formula`,
                })
        }
        for (const a of refs.aggregates) {
            const target = byKey.get(a.table)
            if (!target) {
                issues.push({ path: at, message: `unknown field ${a.table}` })
                continue
            }
            if (target.kind !== 'builtin' && target.kind !== 'table') {
                issues.push({ path: at, message: `${a.table} is not a table` })
                continue
            }
            if (a.column === undefined || !target.columns) continue
            const column = target.columns.find(c => c.key === a.column)
            if (!column) issues.push({ path: at, message: `unknown column ${a.column}` })
            else if (!SUMMABLE_COLUMN_KINDS.has(column.kind))
                issues.push({ path: at, message: `column ${a.column} is not numeric` })
        }
        deps.set(f.key, refs.vars)
    })
    const ordered = orderNodes(deps)
    if ('cycle' in ordered) {
        const index = fields.findIndex(f => f.key === ordered.cycle[0])
        issues.push({
            path: [...base, index, 'expression'],
            message: `formula cycle: ${ordered.cycle.join(' → ')}`,
        })
    }
    return issues
}
