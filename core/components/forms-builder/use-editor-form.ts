import type { DraftDefinition, Removed } from '@tinycld/core/lib/forms/builder'
import {
    definitionSchema,
    type FormDefinition,
    validateDefinitionForHost,
} from '@tinycld/core/lib/forms/definition'
import { mapDefinitionErrors, useFormAdmin } from '@tinycld/core/lib/forms/use-form-admin'
import { useFormHost } from '@tinycld/core/lib/forms/use-form-hosts'
import { useFormRow } from '@tinycld/core/lib/forms/use-forms-of-host'
import { useMemo, useState } from 'react'
import { type FieldPath, useFieldArray, useForm } from 'react-hook-form'

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

export function fromDraft(draft: DraftDefinition): DraftDefinition {
    return {
        ...draft,
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

function noticeFor(removed: Removed): string | null {
    const parts: string[] = []
    if (removed.rules.length)
        parts.push(`${removed.rules.length} rule${removed.rules.length > 1 ? 's' : ''}`)
    if (removed.actions)
        parts.push(`${removed.actions} rule action${removed.actions > 1 ? 's' : ''}`)
    if (removed.defaults) parts.push('its default')
    if (removed.submitRequired) parts.push('its required-on-submit setting')
    return parts.length ? `Also removed ${parts.join(', ')}.` : null
}

export function useEditorForm(formId: string) {
    const { row: loaded } = useFormRow(formId)
    const admin = useFormAdmin(loaded?.host)
    const host = useFormHost(loaded?.host)
    const row = admin.forms.find(f => f.id === formId) ?? loaded
    const values = useMemo(() => (row ? toDraft(row.definition) : undefined), [row])
    const form = useForm<DraftDefinition>({
        values,
        resetOptions: { keepDirtyValues: true },
        mode: 'onBlur',
    })
    const pages = useFieldArray({ control: form.control, name: 'pages' })
    const fields = useFieldArray({ control: form.control, name: 'fields' })
    const rules = useFieldArray({ control: form.control, name: 'rules' })
    // Which cell is selected and the last removal notice: local UI state.
    const [selectedKey, select] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const apply = (op: (def: DraftDefinition) => DraftDefinition) => {
        const next = op(form.getValues())
        form.setValue('pages', next.pages, { shouldDirty: true })
        form.setValue('fields', next.fields, { shouldDirty: true })
        form.setValue('rules', next.rules ?? [], { shouldDirty: true })
        form.setValue('defaults', next.defaults ?? {}, { shouldDirty: true })
        form.setValue('submit', next.submit ?? { required: [] }, { shouldDirty: true })
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

    const setIssue = (path: string, type: string, message: string) => {
        const target = path ? (draftPath(path) as FieldPath<DraftDefinition>) : 'root'
        form.setError(target, { type, message })
    }

    const save = async (): Promise<boolean> => {
        if (!row || !host) return false
        form.clearErrors()
        const parsed = definitionSchema.safeParse(fromDraft(form.getValues()))
        if (!parsed.success) {
            for (const issue of parsed.error.issues)
                setIssue(issue.path.join('.'), 'manual', issue.message)
            return false
        }
        const issues = validateDefinitionForHost(parsed.data, host)
        if (issues.length) {
            for (const issue of issues) setIssue(issue.path.join('.'), 'manual', issue.message)
            return false
        }
        try {
            await admin.saveDefinition.mutateAsync({ id: row.id, definition: parsed.data })
            form.reset(toDraft(parsed.data))
            return true
        } catch (error) {
            const mapped = mapDefinitionErrors(error)
            if (Object.keys(mapped).length === 0) throw error
            for (const [path, message] of Object.entries(mapped)) {
                const isDefinitionPath = /^(pages|fields|rules|defaults|submit|version)(\.|$)/.test(
                    path
                )
                setIssue(isDefinitionPath ? path : '', 'server', message)
            }
            return false
        }
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
        isSaving: admin.saveDefinition.isPending,
        isDirty: form.formState.isDirty,
        isReady: admin.isReady && Boolean(row && host),
        notice,
        dismissNotice: () => setNotice(null),
    }
}
