import jsonLogic, { type RulesLogic } from 'json-logic-js'
import type { FormDefinition, FormRule, RuleCondition, SelectOption } from './definition'

export type FormValues = Record<string, unknown>
export interface EvalContext {
    /** YYYY-MM-DD in the user's local calendar */
    today: string
    userId: string
}
export interface FieldState {
    visible: boolean
    required: boolean
    options?: SelectOption[]
}
export interface FormState {
    fields: Record<string, FieldState>
    pages: Record<string, { visible: boolean }>
    activeRules: string[]
    /** Values set_value actions want applied; the renderer applies them when a rule becomes active. */
    setValues: Record<string, unknown>
}

export type JsonLogicRule = RulesLogic

function isEmpty(v: unknown): boolean {
    if (v === null || v === undefined || v === '' || v === false) return true
    if (Array.isArray(v)) return v.length === 0
    return false
}

/** Adds the three date and user operations plus isEmpty. Idempotent. Mirrored in server/forms/logic.go. */
let registered = false
function ensureOperations() {
    if (registered) return
    registered = true
    jsonLogic.add_operation('isEmpty', (v: unknown) => isEmpty(v))
    jsonLogic.add_operation(
        'allDone',
        (v: unknown) =>
            Array.isArray(v) &&
            v.length > 0 &&
            v.every(i => (i as { done?: boolean }).done === true)
    )
    jsonLogic.add_operation(
        'anyOpen',
        (v: unknown) => Array.isArray(v) && v.some(i => (i as { done?: boolean }).done !== true)
    )
    jsonLogic.add_operation('today', () => currentContext.today)
    jsonLogic.add_operation('me', () => currentContext.userId)
    jsonLogic.add_operation('addDays', (date: unknown, days: unknown) =>
        addDays(String(date), Number(days))
    )
}

/** The context the custom ops read. Set for the duration of one evaluate call; evaluation is synchronous. */
let currentContext: EvalContext = { today: '1970-01-01', userId: '' }

export function addDays(isoDate: string, days: number): string {
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
    const date = new Date(y, m - 1, d + days)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function compileCondition(c: RuleCondition): JsonLogicRule {
    const v = { var: c.field }
    switch (c.op) {
        case 'eq':
        case 'is':
            return { '==': [v, c.value] } as JsonLogicRule
        case 'neq':
        case 'is_not':
            return { '!=': [v, c.value] } as JsonLogicRule
        case 'contains':
            return { in: [c.value, v] } as JsonLogicRule
        case 'starts_with':
            return {
                '==': [{ substr: [v, 0, String(c.value ?? '').length] }, c.value],
            } as JsonLogicRule
        case 'is_any_of':
            return { in: [v, c.value] } as JsonLogicRule
        case 'is_empty':
            return { isEmpty: [v] } as unknown as JsonLogicRule
        case 'not_empty':
            return { '!': { isEmpty: [v] } } as unknown as JsonLogicRule
        case 'gt':
            return { '>': [v, c.value] } as JsonLogicRule
        case 'lt':
        case 'before':
            return { '<': [v, c.value] } as JsonLogicRule
        case 'gte':
            return { '>=': [v, c.value] } as JsonLogicRule
        case 'lte':
            return { '<=': [v, c.value] } as JsonLogicRule
        case 'after':
            return { '>': [v, c.value] } as JsonLogicRule
        case 'is_true':
            return { '==': [v, true] } as JsonLogicRule
        case 'is_false':
            return { '!=': [v, true] } as JsonLogicRule
        case 'all_done':
            return { allDone: [v] } as unknown as JsonLogicRule
        case 'any_open':
            return { anyOpen: [v] } as unknown as JsonLogicRule
    }
}

export function compileRule(r: FormRule): JsonLogicRule {
    const parts = r.when.map(compileCondition)
    return (r.match === 'any' ? { or: parts } : { and: parts }) as JsonLogicRule
}

export function evaluateExpression(
    expr: unknown,
    ctx: EvalContext,
    values: FormValues = {}
): unknown {
    ensureOperations()
    currentContext = ctx
    if (expr !== null && typeof expr === 'object' && !Array.isArray(expr))
        return jsonLogic.apply(expr as JsonLogicRule, values)
    return expr
}

export function evaluate(def: FormDefinition, values: FormValues, ctx: EvalContext): FormState {
    ensureOperations()
    currentContext = ctx
    const data: FormValues = { ...values }
    for (const f of def.fields) if (!(f.key in data)) data[f.key] = null
    const fields: Record<string, FieldState> = {}
    for (const f of def.fields)
        fields[f.key] = {
            visible: !f.hidden,
            required: f.required || def.submit.required.includes(f.key),
        }
    const pages: Record<string, { visible: boolean }> = {}
    for (const p of def.pages) pages[p.key] = { visible: true }
    const activeRules: string[] = []
    const setValues: Record<string, unknown> = {}
    for (const r of def.rules) {
        if (!jsonLogic.apply(compileRule(r), data)) continue
        activeRules.push(r.key)
        for (const a of r.actions) {
            if (a.action === 'show' || a.action === 'hide') {
                const visible = a.action === 'show'
                if (a.page) pages[a.page] = { visible }
                else if (a.field && fields[a.field]) fields[a.field].visible = visible
            } else if (a.action === 'require' && fields[a.field]) fields[a.field].required = true
            else if (a.action === 'set_options' && fields[a.field])
                fields[a.field].options = a.options
            else if (a.action === 'set_value')
                setValues[a.field] = evaluateExpression(a.value, ctx, data)
        }
    }
    for (const f of def.fields) {
        const st = fields[f.key]
        if (!pages[f.page]?.visible) st.visible = false
        if (!st.visible) st.required = false
    }
    return { fields, pages, activeRules, setValues }
}

export function applyDefaults(def: FormDefinition, ctx: EvalContext): FormValues {
    const out: FormValues = {}
    for (const [key, expr] of Object.entries(def.defaults)) out[key] = evaluateExpression(expr, ctx)
    return out
}
