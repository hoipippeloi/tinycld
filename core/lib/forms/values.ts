import { type ZodTypeAny, z } from 'zod'
import type { CustomField, FormDefinition, FormField } from './definition'
import { type FormHostBuiltin, type FormHostDef, findBuiltin } from './host'
import type { FormState, FormValues } from './logic'

export interface ChecklistItem {
    id: string
    text: string
    done: boolean
}
export const checklistItemSchema = z.object({
    id: z.string().min(1),
    text: z.string(),
    done: z.boolean(),
})

/** Resolves what a field really is: a custom field as declared, or the host builtin behind a builtin ref. */
export function resolveKind(
    host: FormHostDef,
    field: FormField
): { kind: string; builtin?: FormHostBuiltin; custom?: CustomField } {
    if (field.kind === 'builtin') {
        const builtin = findBuiltin(host, field.key)
        return { kind: builtin?.kind ?? 'custom', builtin }
    }
    return { kind: field.kind, custom: field }
}

/** True when the field's value travels in the submit payload (not rows, sections or collaborative text). */
export function isSubmittedKind(host: FormHostDef, field: FormField): boolean {
    const { kind, builtin, custom } = resolveKind(host, field)
    if (kind === 'section') return false
    if (builtin?.storage === 'rows') return false
    if (builtin?.collaborative) return false
    if (custom && 'collaborative' in custom && custom.collaborative) return false
    return true
}

function schemaFor(
    host: FormHostDef,
    field: FormField,
    required: boolean,
    options?: { value: string }[]
): ZodTypeAny {
    const { kind, custom, builtin } = resolveKind(host, field)
    const multiple =
        (custom && 'multiple' in custom && custom.multiple) || builtin?.multiple || false
    const missing = `${field.label} is required`
    let s: ZodTypeAny
    switch (kind) {
        case 'text':
        case 'textarea':
        case 'richtext':
        case 'markdown': {
            let t = z.string()
            if (custom?.kind === 'text' && custom.maxLength) t = t.max(custom.maxLength)
            s = required ? t.trim().min(1, missing) : t.nullable()
            break
        }
        case 'number': {
            let n = z.number()
            if (custom?.kind === 'number') {
                if (custom.min !== undefined) n = n.min(custom.min)
                if (custom.max !== undefined) n = n.max(custom.max)
            }
            s = required ? n : n.nullable()
            break
        }
        case 'toggle':
            s = required ? z.literal(true, { message: missing }) : z.boolean().nullable()
            break
        case 'date':
            s = required ? z.string().min(1, missing) : z.string().nullable()
            break
        case 'select': {
            const allowed = (options ?? (custom?.kind === 'select' ? custom.options : [])).map(
                o => o.value
            )
            const one =
                allowed.length > 0
                    ? z.enum(allowed as [string, ...string[]])
                    : z.never({ message: `${field.label} has no options` })
            if (multiple) {
                const many = z.array(one)
                s = required ? many.min(1, missing) : many.nullable()
            } else {
                s = required ? one : one.nullable()
            }
            break
        }
        case 'user':
        case 'file':
            if (multiple) {
                const many = z.array(z.string())
                s = required ? many.min(1, missing) : many.nullable()
            } else {
                s = required ? z.string().min(1, missing) : z.string().nullable()
            }
            break
        case 'checklist': {
            const items = z.array(checklistItemSchema)
            s = required ? items.min(1, missing) : items.nullable()
            break
        }
        default:
            s = required
                ? z.unknown().refine(v => v !== null && v !== undefined && v !== '', missing)
                : z.unknown()
    }
    return required ? s : s.optional()
}

/** The submit schema for the fields visible in this state. Rows, sections and collaborative text are excluded. */
export function buildSchema(def: FormDefinition, host: FormHostDef, state: FormState) {
    const shape: Record<string, ZodTypeAny> = {}
    for (const f of def.fields) {
        if (!isSubmittedKind(host, f)) continue
        const st = state.fields[f.key]
        if (!st?.visible) continue
        shape[f.key] = schemaFor(host, f, st.required, st.options)
    }
    // Passthrough keeps hidden, row and collaborative values in the output, so the resolver can
    // hand them to splitValues. Only the keys in `shape` are validated.
    return z.object(shape).passthrough()
}

export interface SplitValues {
    columns: Record<string, unknown>
    fields: Record<string, unknown>
    rows: Record<string, ChecklistItem[]>
}

/** Routes each value to the record column, the custom-field JSON column, or its own rows table. */
export function splitValues(
    host: FormHostDef,
    def: FormDefinition,
    values: FormValues
): SplitValues {
    const out: SplitValues = { columns: {}, fields: {}, rows: {} }
    for (const f of def.fields) {
        const v = values[f.key]
        if (v === undefined) continue
        const { kind, builtin } = resolveKind(host, f)
        if (kind === 'section') continue
        if (builtin?.storage === 'rows')
            out.rows[f.key] = Array.isArray(v) ? (v as ChecklistItem[]) : []
        else if (builtin) out.columns[f.key] = v
        else out.fields[f.key] = v
    }
    return out
}

/** The inverse of splitValues. A null JSON column reads as no custom values. */
export function mergeValues(
    host: FormHostDef,
    def: FormDefinition,
    record: Record<string, unknown>,
    rows: Record<string, ChecklistItem[]> = {}
): FormValues {
    const json = (record[host.fieldsColumn] ?? {}) as Record<string, unknown>
    const out: FormValues = {}
    for (const f of def.fields) {
        const { kind, builtin } = resolveKind(host, f)
        if (kind === 'section') continue
        if (builtin?.storage === 'rows') out[f.key] = rows[f.key] ?? []
        else if (builtin) out[f.key] = record[f.key]
        else out[f.key] = json[f.key]
    }
    return out
}
