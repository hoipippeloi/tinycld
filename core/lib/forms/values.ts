import { type ZodTypeAny, z } from 'zod'
import {
    type CustomField,
    dateValueSchema,
    type FormDefinition,
    type FormField,
} from './definition'
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

interface KindSchemaInput {
    custom?: CustomField
    required: boolean
    multiple: boolean
    missing: string
    label: string
    options?: { value: string }[]
}

/**
 * A required field with no value at all (never typed, so not even `''`) must
 * read as missing, not as zod's "expected string, received undefined".
 */
function absent(missing: string) {
    return {
        error: (issue: { input?: unknown }) =>
            issue.input === undefined || issue.input === null ? missing : undefined,
    }
}

function textSchema({ custom, required, missing }: KindSchemaInput): ZodTypeAny {
    let t = z.string(absent(missing))
    if (custom?.kind === 'text' && custom.maxLength) t = t.max(custom.maxLength)
    return required ? t.trim().min(1, missing) : t.nullable()
}

function numberSchema({ custom, required, missing }: KindSchemaInput): ZodTypeAny {
    let n = z.number(absent(missing))
    if (custom?.kind === 'number') {
        if (custom.min !== undefined) n = n.min(custom.min)
        if (custom.max !== undefined) n = n.max(custom.max)
    }
    return required ? n : n.nullable()
}

function dateSchema({ custom, required, missing }: KindSchemaInput): ZodTypeAny {
    // A built-in date is a record column in the database's own format; a custom date is
    // stored as typed, so it has the shape the server checks (DATE_RE).
    const d = custom ? dateValueSchema : z.string()
    return required ? z.string(absent(missing)).min(1, missing).pipe(d) : d.nullable()
}

function selectSchema(input: KindSchemaInput): ZodTypeAny {
    const { custom, required, multiple, missing, label, options } = input
    const allowed = (options ?? (custom?.kind === 'select' ? custom.options : [])).map(o => o.value)
    const one =
        allowed.length > 0
            ? z.enum(allowed as [string, ...string[]], absent(missing))
            : z.never({ message: `${label} has no options` })
    if (!multiple) return required ? one : one.nullable()
    const many = z.array(one, absent(missing))
    return required ? many.min(1, missing) : many.nullable()
}

function idSchema({ required, multiple, missing }: KindSchemaInput): ZodTypeAny {
    if (!multiple)
        return required ? z.string(absent(missing)).min(1, missing) : z.string().nullable()
    const many = z.array(z.string(), absent(missing))
    return required ? many.min(1, missing) : many.nullable()
}

function listSchema({ required, missing }: KindSchemaInput): ZodTypeAny {
    const items = z.array(checklistItemSchema, absent(missing))
    return required ? items.min(1, missing) : items.nullable()
}

function anySchema({ required, missing }: KindSchemaInput): ZodTypeAny {
    if (!required) return z.unknown()
    return z.unknown().refine(v => v !== null && v !== undefined && v !== '', missing)
}

const SCHEMA_BY_KIND: Record<string, (input: KindSchemaInput) => ZodTypeAny> = {
    text: textSchema,
    textarea: textSchema,
    richtext: textSchema,
    markdown: textSchema,
    number: numberSchema,
    toggle: ({ required, missing }) =>
        required ? z.literal(true, { message: missing }) : z.boolean().nullable(),
    date: dateSchema,
    select: selectSchema,
    user: idSchema,
    file: idSchema,
    checklist: listSchema,
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
    const build = SCHEMA_BY_KIND[kind] ?? anySchema
    const s = build({
        custom,
        required,
        multiple,
        missing: `${field.label} is required`,
        label: field.label,
        options,
    })
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
