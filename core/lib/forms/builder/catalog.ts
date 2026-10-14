import type { CatalogField } from '../../automation/api'
import {
    type ConditionOp,
    type FormDefinitionInput,
    OPERATORS_BY_KIND,
    type RuleAction,
} from '../definition'
import { type FormHostDef, findBuiltin } from '../host'

export function kindOf(
    def: FormDefinitionInput,
    host: FormHostDef,
    key: string
): string | undefined {
    const field = def.fields.find(f => f.key === key)
    if (!field) return undefined
    if (field.kind === 'builtin') return findBuiltin(host, key)?.kind ?? 'custom'
    return field.kind
}

/** The shape `core/components/rules/ValueInput` consumes for a scalar condition value. */
export function catalogFieldFor(
    def: FormDefinitionInput,
    host: FormHostDef,
    key: string
): CatalogField | undefined {
    const field = def.fields.find(f => f.key === key)
    const kind = kindOf(def, host, key)
    if (!field || !kind) return undefined
    const base = { key, label: field.label }
    switch (kind) {
        case 'number':
            return { ...base, type: 'number' }
        case 'date':
            return { ...base, type: 'date' }
        case 'toggle':
        case 'checklist':
            return { ...base, type: 'boolean' }
        case 'select':
            return {
                ...base,
                type: 'select',
                options: 'options' in field ? field.options.map(o => o.value) : [],
            }
        case 'user':
            return { ...base, type: 'relation', relationTarget: 'users', displayField: 'name' }
        default:
            return { ...base, type: 'text' }
    }
}

export function operatorsFor(kind: string): ConditionOp[] {
    return [...(OPERATORS_BY_KIND[kind] ?? [])]
}

export const NO_VALUE_OPS = new Set<ConditionOp>([
    'is_empty',
    'not_empty',
    'is_true',
    'is_false',
    'all_done',
    'any_open',
])
export const LIST_VALUE_OPS = new Set<ConditionOp>(['is_any_of'])

export const OPERATOR_LABELS: Record<ConditionOp, string> = {
    eq: 'equals',
    neq: 'does not equal',
    contains: 'contains',
    starts_with: 'starts with',
    is_empty: 'is empty',
    not_empty: 'is not empty',
    gt: 'is greater than',
    lt: 'is less than',
    gte: 'is at least',
    lte: 'is at most',
    before: 'is before',
    after: 'is after',
    is_true: 'is on',
    is_false: 'is off',
    is: 'is',
    is_not: 'is not',
    is_any_of: 'is any of',
    all_done: 'is all done',
    any_open: 'has an open item',
}

export type ActionKind = RuleAction['action']
export const ACTION_LABELS: Record<ActionKind, string> = {
    show: 'Show',
    hide: 'Hide',
    require: 'Require',
    set_options: 'Set options',
    set_value: 'Set value',
}

export function actionsFor(targetKind: string | 'page'): ActionKind[] {
    if (targetKind === 'page' || targetKind === 'section') return ['show', 'hide']
    if (targetKind === 'select') return ['show', 'hide', 'require', 'set_options', 'set_value']
    return ['show', 'hide', 'require', 'set_value']
}
