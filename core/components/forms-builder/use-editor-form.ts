import { toNestErrors } from '@hookform/resolvers'
import {
    coerceLiteral,
    type DraftDefinition,
    kindOf,
    type Removed,
} from '@tinycld/core/lib/forms/builder'
import {
    DATE_RE,
    type DefinitionIssue,
    definitionSchema,
    type FormDefinition,
    validateDefinitionForHost,
} from '@tinycld/core/lib/forms/definition'
import type { FormHostDef } from '@tinycld/core/lib/forms/host'
import { mapDefinitionErrors, useFormAdmin } from '@tinycld/core/lib/forms/use-form-admin'
import type { FormHost } from '@tinycld/core/lib/forms/use-form-hosts'
import type { FormRow } from '@tinycld/core/lib/forms/use-forms-of-host'
import { log } from '@tinycld/core/lib/logger'
import { useMemo, useState } from 'react'
import {
    type FieldError,
    type FieldPath,
    type Resolver,
    type UseFormReturn,
    useFieldArray,
    useForm,
} from 'react-hook-form'
import { errorLeaves } from './editor-errors'

/** File fields edit `accept` as one comma-separated text input. */
export function toDraft(definition: FormDefinition): DraftDefinition {
    return {
        ...definition,
        fields: definition.fields.map(f =>
            f.kind === 'file' ? { ...f, acceptText: f.accept.join(', ') } : f
        ),
    }
}

// A cleared optional input holds '' rather than nothing; the schema wants the prop absent.
const CLEARABLE = new Set(['description', 'placeholder', 'min', 'max', 'step', 'maxLength', 'rows'])

function withoutCleared<F extends object>(field: F): F {
    const kept = Object.entries(field).filter(
        ([key, value]) => !(CLEARABLE.has(key) && value === '')
    )
    // Every CLEARABLE prop is optional on every kind, so dropping one keeps the field's type.
    return Object.fromEntries(kept) as F
}

/** `accept` is edited as one `acceptText` input, so its errors are shown there. */
export function draftPath(path: string): string {
    return path.replace(/^(fields\.\d+)\.accept(\.\d+)?$/, '$1.acceptText')
}

/**
 * A typed-in default is text until it is saved; it is typed here by its
 * field's kind. An empty one (no text, or no options picked) means no default.
 */
function typedDefaults(draft: DraftDefinition, host: FormHostDef): DraftDefinition['defaults'] {
    const out: NonNullable<DraftDefinition['defaults']> = {}
    for (const [key, expr] of Object.entries(draft.defaults ?? {})) {
        if (Array.isArray(expr) && expr.length === 0) continue
        if (typeof expr !== 'string') out[key] = expr
        else if (expr.trim() !== '') out[key] = coerceLiteral(kindOf(draft, host, key) ?? '', expr)
    }
    return out
}

/** Defaults the schema cannot judge, because it does not know a builtin's kind. */
export function defaultIssues(draft: DraftDefinition, host: FormHostDef): DefinitionIssue[] {
    return Object.entries(draft.defaults ?? {}).flatMap(([key, expr]) => {
        if (kindOf(draft, host, key) !== 'number') return []
        if (typeof expr === 'number' && Number.isFinite(expr)) return []
        const label = draft.fields.find(f => f.key === key)?.label ?? key
        return [{ path: ['defaults', key], message: `${label} default must be a number` }]
    })
}

export function fromDraft(draft: DraftDefinition, host: FormHostDef): DraftDefinition {
    return {
        ...draft,
        defaults: typedDefaults(draft, host),
        fields: draft.fields.map(draftField => {
            const field = withoutCleared(draftField)
            if (field.kind !== 'file') return field
            const { acceptText, ...rest } = field
            if (acceptText === undefined) return rest
            const accept = acceptText
                .split(',')
                .map(part => part.trim())
                .filter(Boolean)
            return { ...rest, accept }
        }),
    }
}

/** What a removal takes with it, as list items: "2 rules", "its default". */
export function removalParts(removed: Removed): string[] {
    const parts: string[] = []
    if (removed.rules.length)
        parts.push(`${removed.rules.length} rule${removed.rules.length > 1 ? 's' : ''}`)
    if (removed.actions)
        parts.push(`${removed.actions} rule action${removed.actions > 1 ? 's' : ''}`)
    if (removed.defaults) parts.push('its default')
    if (removed.submitRequired) parts.push('its required-on-submit setting')
    return parts
}

function noticeFor(removed: Removed): string | null {
    const parts = removalParts(removed)
    return parts.length ? `Also removed ${parts.join(', ')}.` : null
}

const DATE_MESSAGE = 'Use YYYY-MM-DD'
const isDateText = (value: unknown) => typeof value === 'string' && DATE_RE.test(value)

/**
 * Dates the schema cannot judge without the host, which knows a built-in's
 * kind: a date default or set_value typed as text, and the date a before or
 * after condition compares with.
 */
export function dateIssues(def: FormDefinition, host: FormHostDef): DefinitionIssue[] {
    const isDate = (key: string) => kindOf(def, host, key) === 'date'
    const issues: DefinitionIssue[] = []
    for (const [key, expr] of Object.entries(def.defaults))
        if (isDate(key) && typeof expr === 'string' && !isDateText(expr))
            issues.push({ path: ['defaults', key], message: DATE_MESSAGE })
    def.rules.forEach((rule, ri) => {
        rule.when.forEach((c, ci) => {
            if ((c.op === 'before' || c.op === 'after') && isDate(c.field) && !isDateText(c.value))
                issues.push({ path: ['rules', ri, 'when', ci, 'value'], message: DATE_MESSAGE })
        })
        rule.actions.forEach((a, ai) => {
            if (a.action !== 'set_value' || !isDate(a.field)) return
            if (typeof a.value === 'string' && !isDateText(a.value))
                issues.push({ path: ['rules', ri, 'actions', ai, 'value'], message: DATE_MESSAGE })
        })
    })
    return issues
}

/** The definition with every check the server makes, including the host's. */
function editorSchema(host: FormHostDef) {
    return definitionSchema.superRefine((def, ctx) => {
        const issues = [
            ...defaultIssues(def, host),
            ...dateIssues(def, host),
            ...validateDefinitionForHost(def, host),
        ]
        for (const issue of issues)
            ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    })
}

/**
 * Validates the draft as the definition it saves as. This is what zodResolver
 * does (safeParse, then nest the issues), with two editor steps around it:
 * the draft goes through `fromDraft` first, and an `accept` issue is moved to
 * the `acceptText` input the editor shows it on.
 */
export function editorResolver(
    host: FormHostDef
): Resolver<DraftDefinition, unknown, FormDefinition> {
    const schema = editorSchema(host)
    return async (values, _context, options) => {
        const parsed = schema.safeParse(fromDraft(values, host))
        if (parsed.success) return { values: parsed.data, errors: {} }
        const flat: Record<string, FieldError> = {}
        for (const issue of parsed.error.issues) {
            const path = draftPath(issue.path.join('.')) || 'root'
            flat[path] ??= { type: issue.code, message: issue.message }
        }
        return { values: {}, errors: toNestErrors(flat, options) }
    }
}

const SAVE_FAILED = 'The form could not be saved. Try again.'
const DEFINITION_PATH = /^(pages|fields|rules|defaults|submit|version)(\.|$)/

type EditorForm = UseFormReturn<DraftDefinition, unknown, FormDefinition>
type DraftField = DraftDefinition['fields'][number]

function sameKeys(a: DraftField[], b: DraftField[]) {
    return a.length === b.length && a.every((f, i) => f.key === b[i]?.key)
}

/**
 * Field errors are indexed by position, so a move or a removal would leave
 * them on whichever field now sits there. They follow their field's key instead.
 */
function carryFieldErrors(form: EditorForm, prev: DraftField[], next: DraftField[]) {
    const errors = form.formState.errors.fields
    if (!errors || sameKeys(prev, next)) return
    const byKey = new Map(prev.map((f, i) => [f.key, errorLeaves(errors[i])]))
    form.clearErrors(prev.map((_, i) => `fields.${i}` as const))
    next.forEach((field, index) => {
        for (const leaf of byKey.get(field.key) ?? []) {
            const path = leaf.path ? `fields.${index}.${leaf.path}` : `fields.${index}`
            form.setError(path as FieldPath<DraftDefinition>, {
                type: leaf.type,
                message: leaf.message,
            })
        }
    })
}

/** Stable JSON: the server may store a definition's keys in another order. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
    }
    return JSON.stringify(value)
}

export function sameDefinition(a: FormDefinition, b: FormDefinition): boolean {
    return canonical(a) === canonical(b)
}

/** What the editor needs of the row: the live query's own row type, narrowed. */
export type EditorRow = Pick<FormRow, 'id' | 'name' | 'host' | 'definition'>

/**
 * The editor's form over a loaded row. The draft is read from the row once:
 * a pbtsdb write is optimistic, so the live row changes (and changes back on a
 * rejected save) while the user edits, and must never be merged into the draft.
 * A change made elsewhere is reported through `isChangedElsewhere` instead.
 */
export function useEditorForm(row: EditorRow, host: FormHost) {
    const admin = useFormAdmin(row.host)
    const resolver = useMemo(() => editorResolver(host), [host])
    const form = useForm<DraftDefinition, unknown, FormDefinition>({
        defaultValues: toDraft(row.definition),
        resolver,
        mode: 'onBlur',
    })
    const pages = useFieldArray({ control: form.control, name: 'pages' })
    const fields = useFieldArray({ control: form.control, name: 'fields' })
    const rules = useFieldArray({ control: form.control, name: 'rules' })
    // The selected cell, the last removal notice and the definition the draft
    // started from (to spot a change made elsewhere): local UI state.
    const [selectedKey, select] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [base, setBase] = useState(row.definition)
    const isSaving = admin.saveDefinition.isPending

    const apply = (op: (def: DraftDefinition) => DraftDefinition) => {
        const prev = form.getValues()
        const next = op(prev)
        form.setValue('pages', next.pages, { shouldDirty: true })
        form.setValue('fields', next.fields, { shouldDirty: true })
        form.setValue('rules', next.rules ?? [], { shouldDirty: true })
        form.setValue('defaults', next.defaults ?? {}, { shouldDirty: true })
        form.setValue('submit', next.submit ?? { required: [] }, { shouldDirty: true })
        carryFieldErrors(form, prev.fields, next.fields)
    }
    const applyRemoval = (
        op: (def: DraftDefinition) => { definition: DraftDefinition; removed: Removed }
    ): Removed => {
        const { definition, removed } = op(form.getValues())
        apply(() => definition)
        setNotice(noticeFor(removed))
        if (selectedKey && !definition.fields.some(f => f.key === selectedKey)) select(null)
        return removed
    }

    const showServerErrors = (error: unknown) => {
        const mapped = mapDefinitionErrors(error)
        if (Object.keys(mapped).length === 0) {
            log.error('forms.editor', error, { formId: row.id })
            form.setError('root', { type: 'server', message: SAVE_FAILED })
            return
        }
        for (const [path, message] of Object.entries(mapped)) {
            const target = DEFINITION_PATH.test(path) ? draftPath(path) : 'root'
            form.setError(target as FieldPath<DraftDefinition>, { type: 'server', message })
        }
    }

    const save = async (): Promise<boolean> => {
        let isSaved = false
        await form.handleSubmit(async definition => {
            try {
                await admin.saveDefinition.mutateAsync({ id: row.id, definition })
                form.reset(toDraft(definition))
                setBase(definition)
                isSaved = true
            } catch (error) {
                showServerErrors(error)
            }
        })()
        return isSaved
    }

    /** Drops the draft for the definition as it is stored now. */
    const reload = () => {
        form.reset(toDraft(row.definition))
        setBase(row.definition)
        setNotice(null)
        if (selectedKey && !row.definition.fields.some(f => f.key === selectedKey)) select(null)
    }

    return {
        host,
        row,
        form,
        pages,
        fields,
        rules,
        selectedKey,
        select,
        apply,
        applyRemoval,
        save,
        isSaving,
        isDirty: form.formState.isDirty,
        isChangedElsewhere: !isSaving && !sameDefinition(row.definition, base),
        reload,
        notice,
        dismissNotice: () => setNotice(null),
    }
}
