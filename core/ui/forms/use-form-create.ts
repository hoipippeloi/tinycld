import type { FormDefinition } from '@tinycld/core/lib/forms/definition'
import {
    applyDefaults,
    type EvalContext,
    evaluate,
    type FormValues,
} from '@tinycld/core/lib/forms/logic'
import { useFormsOfHost } from '@tinycld/core/lib/forms/use-forms-of-host'
import { buildSchema, type SplitValues, splitValues } from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { EMPTY_DEFINITION, EMPTY_STATE } from './empty-schema'
import { useSchemaRefResolver } from './use-schema-ref-resolver'

export function useFormCreate(
    host: FormHost,
    initialFormId: string | undefined,
    context: EvalContext
) {
    const { forms, defaultForm, isReady } = useFormsOfHost(host.key)
    // Which type the dialog shows: local UI state until the record exists.
    const [formId, setFormId] = useState(initialFormId ?? defaultForm?.id ?? '')
    const row = forms.find(f => f.id === (formId || defaultForm?.id))
    const definition: FormDefinition | undefined = row?.definition
    const initialSchema = definition
        ? buildSchema(definition, host, evaluate(definition, {}, context))
        : buildSchema(EMPTY_DEFINITION, host, EMPTY_STATE)
    const { schemaRef, resolver } = useSchemaRefResolver(initialSchema)
    const form = useForm<FormValues>({
        resolver,
        defaultValues: definition ? applyDefaults(definition, context) : {},
        mode: 'onSubmit',
    })

    const switchForm = (nextId: string) => {
        const next = forms.find(f => f.id === nextId)
        if (!next) return
        const current = form.getValues()
        const kept: FormValues = {}
        for (const f of next.definition.fields) {
            if (current[f.key] !== undefined && current[f.key] !== '') kept[f.key] = current[f.key]
        }
        form.reset({ ...applyDefaults(next.definition, context), ...kept })
        setFormId(nextId)
    }

    const submit = async (): Promise<SplitValues | null> => {
        if (!definition) return null
        schemaRef.current = buildSchema(
            definition,
            host,
            evaluate(definition, form.getValues(), context)
        )
        let out: SplitValues | null = null
        await form.handleSubmit(values => {
            out = splitValues(host, definition, values)
        })()
        return out
    }

    return { form, schemaRef, definition, formId: row?.id ?? '', switchForm, submit, isReady }
}
