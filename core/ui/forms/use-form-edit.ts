import type { FormDefinition } from '@tinycld/core/lib/forms/definition'
import { type EvalContext, evaluate, type FormValues } from '@tinycld/core/lib/forms/logic'
import { useFormsOfHost } from '@tinycld/core/lib/forms/use-forms-of-host'
import {
    buildSchema,
    type ChecklistItem,
    mergeValues,
    type SplitValues,
    splitValues,
} from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { useForm } from 'react-hook-form'
import { EMPTY_DEFINITION, EMPTY_STATE } from './empty-schema'
import { formErrorHandler } from './form-error-handler'
import { useSchemaRefResolver } from './use-schema-ref-resolver'

/**
 * Edit mode: values come from the record; each `patch()` returns the keys
 * that changed, split for the host's update mutation. When a custom key
 * changed, `fields` is the record's whole JSON column with the changes laid
 * over it, so the host can write it as is without dropping other keys.
 *
 * The record is a live row, so the `values` prop updates when another client
 * edits it, and react-hook-form resets to it while keeping what the user is
 * typing. `patch()` validates only the dirty keys and returns null when one is
 * invalid. It does not mark anything saved: the host writes the result, then
 * calls `markSaved(written)` with the result's `written` map in the mutation's
 * `onSuccess`. A failed write therefore leaves the keys dirty and a retry sends
 * them again. `written` holds only the dirty keys and the values that were
 * sent, so an edit made while the write was in flight stays dirty.
 */
export type PatchResult = SplitValues & { written: FormValues }

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function useFormEdit(
    host: FormHost,
    record: Record<string, unknown> & { id: string },
    context: EvalContext,
    rows: Record<string, ChecklistItem[]> = {}
) {
    const { forms, defaultForm, isReady } = useFormsOfHost(host.key)
    const named = (record[host.formColumn] as string) || ''
    const found = forms.find(f => f.id === named)
    const chosen = found ?? defaultForm
    const definition: FormDefinition | undefined = chosen?.definition
    // The form the record names is deleted or unreadable: the record edits on the
    // default, and the host can log the id it lost. Not while the forms still load.
    const fallback = named && isReady && !found ? named : undefined
    const values = definition ? mergeValues(host, definition, record, rows) : {}
    const initialSchema = definition
        ? buildSchema(definition, host, evaluate(definition, values, context))
        : buildSchema(EMPTY_DEFINITION, host, EMPTY_STATE)
    const { schemaRef, resolver } = useSchemaRefResolver(initialSchema)
    const form = useForm<FormValues>({
        resolver,
        values,
        resetOptions: { keepDirtyValues: true },
        mode: 'onBlur',
    })

    const markSaved = (written: FormValues) => {
        for (const [key, value] of Object.entries(written)) {
            // The user kept typing during the write: this key is still dirty.
            if (!sameValue(form.getValues(key), value)) continue
            // resetField acts only on a registered field. A field on a page the user never
            // opened has no Controller yet, so it is registered here first.
            form.register(key)
            form.resetField(key, { defaultValue: form.getValues(key) })
        }
    }

    const patch = async (): Promise<PatchResult | null> => {
        if (!definition) return null
        schemaRef.current = buildSchema(
            definition,
            host,
            evaluate(definition, form.getValues(), context)
        )
        const dirtyKeys = definition.fields
            .map(f => f.key)
            .filter(key => form.getFieldState(key).isDirty)
        // Only the dirty keys are validated: a field an admin tightened later must not
        // block an unrelated edit.
        const ok = await form.trigger(dirtyKeys)
        if (!ok) return null
        const values = form.getValues()
        const changed: FormValues = {}
        for (const key of dirtyKeys) changed[key] = values[key]
        const split = splitValues(host, definition, changed)
        const stored = (record[host.fieldsColumn] ?? {}) as Record<string, unknown>
        const hasCustom = Object.keys(split.fields).length > 0
        return {
            ...split,
            fields: hasCustom ? { ...stored, ...split.fields } : {},
            written: changed,
        }
    }

    return {
        form,
        schemaRef,
        definition,
        fallback,
        patch,
        markSaved,
        onError: formErrorHandler(host, form, 'update record'),
        isReady,
    }
}
