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
import { useSchemaRefResolver } from './use-schema-ref-resolver'

/**
 * Edit mode: values come from the record; each `patch()` returns only the
 * keys that changed, split for the host's update mutation. The record is a
 * live row, so the `values` prop updates when another client edits it, and
 * react-hook-form resets to it while keeping what the user is typing.
 */
export function useFormEdit(
    host: FormHost,
    record: Record<string, unknown> & { id: string },
    context: EvalContext,
    rows: Record<string, ChecklistItem[]> = {}
) {
    const { forms, defaultForm, isReady } = useFormsOfHost(host.key)
    const formId = (record[host.formColumn] as string) || defaultForm?.id
    const definition: FormDefinition | undefined = forms.find(f => f.id === formId)?.definition
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

    const patch = async (): Promise<SplitValues | null> => {
        if (!definition) return null
        schemaRef.current = buildSchema(
            definition,
            host,
            evaluate(definition, form.getValues(), context)
        )
        let out: SplitValues | null = null
        await form.handleSubmit(next => {
            const changed: FormValues = {}
            const dirtyKeys = definition.fields
                .map(f => f.key)
                .filter(key => form.getFieldState(key).isDirty)
            for (const key of dirtyKeys) changed[key] = next[key]
            out = splitValues(host, definition, changed)
        })()
        return out
    }

    return { form, schemaRef, definition, patch, isReady }
}
