import { z } from 'zod'
import { keySchema } from './key'

/**
 * A formula: a closed tree of arithmetic over numbers, field values and table
 * aggregates. Mirrored in Go (server/forms/compute_validate.go, compute.go);
 * the shared fixture lib/forms/fixtures/computed-fixture.json pins both.
 */
export type ComputeExpr =
    | number
    | { var: string }
    | { add: ComputeExpr[] }
    | { sub: [ComputeExpr, ComputeExpr] }
    | { mul: ComputeExpr[] }
    | { div: [ComputeExpr, ComputeExpr] }
    | { round: [ComputeExpr, number] }
    | { min: ComputeExpr[] }
    | { max: ComputeExpr[] }
    | { sumOf: [{ var: string }, string] }
    | { count: [{ var: string }] }

const varRef = z.strictObject({ var: keySchema })

export const computeExprSchema: z.ZodType<ComputeExpr> = z.lazy(() =>
    z.union([
        z.number(),
        varRef,
        z.strictObject({ add: z.array(computeExprSchema).min(2) }),
        z.strictObject({ sub: z.tuple([computeExprSchema, computeExprSchema]) }),
        z.strictObject({ mul: z.array(computeExprSchema).min(2) }),
        z.strictObject({ div: z.tuple([computeExprSchema, computeExprSchema]) }),
        z.strictObject({
            round: z.tuple([computeExprSchema, z.number().int().min(0).max(6)]),
        }),
        z.strictObject({ min: z.array(computeExprSchema).min(1) }),
        z.strictObject({ max: z.array(computeExprSchema).min(1) }),
        z.strictObject({ sumOf: z.tuple([varRef, keySchema]) }),
        z.strictObject({ count: z.tuple([varRef]) }),
    ])
)

export interface ExprRefs {
    vars: string[]
    aggregates: { table: string; column?: string }[]
}

/** Every field the formula reads, in the order it reads them. */
export function exprRefs(expr: ComputeExpr): ExprRefs {
    const out: ExprRefs = { vars: [], aggregates: [] }
    const walk = (e: ComputeExpr) => {
        if (typeof e === 'number') return
        if ('var' in e) out.vars.push(e.var)
        else if ('add' in e) e.add.forEach(walk)
        else if ('sub' in e) e.sub.forEach(walk)
        else if ('mul' in e) e.mul.forEach(walk)
        else if ('div' in e) e.div.forEach(walk)
        else if ('round' in e) walk(e.round[0])
        else if ('min' in e) e.min.forEach(walk)
        else if ('max' in e) e.max.forEach(walk)
        else if ('sumOf' in e) out.aggregates.push({ table: e.sumOf[0].var, column: e.sumOf[1] })
        else out.aggregates.push({ table: e.count[0].var })
    }
    walk(expr)
    return out
}

function num(v: unknown): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0
    return v === true ? 1 : 0
}

function rowsOf(v: unknown): Record<string, unknown>[] {
    if (!Array.isArray(v)) return []
    return v.filter(
        (r): r is Record<string, unknown> =>
            typeof r === 'object' && r !== null && !Array.isArray(r)
    )
}

/** Rounds half away from zero at `decimals` places. Never returns -0. */
export function roundHalfAway(x: number, decimals: number): number {
    const p = 10 ** decimals
    const r = Math.round(Math.abs(x) * p) / p
    if (r === 0) return 0
    return x < 0 ? -r : r
}

export function evalCompute(expr: ComputeExpr, scope: Record<string, unknown>): number {
    if (typeof expr === 'number') return expr
    if ('var' in expr) return num(scope[expr.var])
    if ('add' in expr) return expr.add.reduce<number>((s, e) => s + evalCompute(e, scope), 0)
    if ('sub' in expr) return evalCompute(expr.sub[0], scope) - evalCompute(expr.sub[1], scope)
    if ('mul' in expr) return expr.mul.reduce<number>((p, e) => p * evalCompute(e, scope), 1)
    if ('div' in expr) {
        const d = evalCompute(expr.div[1], scope)
        return d === 0 ? 0 : evalCompute(expr.div[0], scope) / d
    }
    if ('round' in expr) return roundHalfAway(evalCompute(expr.round[0], scope), expr.round[1])
    if ('min' in expr) return Math.min(...expr.min.map(e => evalCompute(e, scope)))
    if ('max' in expr) return Math.max(...expr.max.map(e => evalCompute(e, scope)))
    if ('sumOf' in expr) {
        const column = expr.sumOf[1]
        return rowsOf(scope[expr.sumOf[0].var]).reduce((s, r) => s + num(r[column]), 0)
    }
    return rowsOf(scope[expr.count[0].var]).length
}

/**
 * Orders nodes so each follows everything it depends on. Dependencies that are
 * not nodes (plain fields) are ignored. When no order exists, returns the keys
 * on one cycle, closed (`['a', 'b', 'a']`).
 */
export function orderNodes(deps: Map<string, string[]>): { order: string[] } | { cycle: string[] } {
    const order: string[] = []
    const state = new Map<string, 'visiting' | 'done'>()
    const found: { cycle: string[] | null } = { cycle: null }
    const visit = (key: string, stack: string[]) => {
        if (found.cycle) return
        const s = state.get(key)
        if (s === 'done') return
        if (s === 'visiting') {
            found.cycle = [...stack.slice(stack.indexOf(key)), key]
            return
        }
        state.set(key, 'visiting')
        for (const d of deps.get(key) ?? []) if (deps.has(d)) visit(d, [...stack, key])
        state.set(key, 'done')
        order.push(key)
    }
    for (const key of [...deps.keys()].sort()) visit(key, [])
    return found.cycle ? { cycle: found.cycle } : { order }
}
