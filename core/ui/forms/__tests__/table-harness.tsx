import { type UseFormReturn, useForm } from 'react-hook-form'
import type { FormDefinition } from '../../../lib/forms/definition'
import type { FormHostUi } from '../../../lib/forms/host-ui'
import { evaluate, type FormValues } from '../../../lib/forms/logic'
import { buildSchema } from '../../../lib/forms/values'
import type { FormHost } from '../../../lib/packages/derive-form-hosts'
import { FormRenderer } from '../FormRenderer'
import { useSchemaRefResolver } from '../use-schema-ref-resolver'

export const ctx = { today: '2026-01-01', userId: 'u' }

export interface TableHarnessProps {
    host: FormHost
    definition: FormDefinition
    initialValues: FormValues
    layout?: 'sections' | 'wizard'
    ui?: FormHostUi | null
    readOnly?: boolean
    recordId?: string
    onSubmit?: () => void
    formRef?: { current: UseFormReturn<FormValues> | null }
}

/** The renderer over a plain react-hook-form, as a create screen would mount it. */
export function TableHarness(props: TableHarnessProps) {
    const { host, definition, initialValues, formRef } = props
    const initial = buildSchema(definition, host, evaluate(definition, initialValues, ctx))
    const { schemaRef, resolver } = useSchemaRefResolver(initial)
    const form = useForm<FormValues>({ defaultValues: initialValues, resolver })
    if (formRef) formRef.current = form
    return (
        <FormRenderer
            host={host}
            ui={props.ui ?? null}
            definition={definition}
            layout={props.layout ?? 'sections'}
            form={form}
            schemaRef={schemaRef}
            context={ctx}
            readOnly={props.readOnly}
            recordId={props.recordId}
            onSubmit={props.onSubmit}
        />
    )
}

export function byTestId(container: HTMLElement, id: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`[testID="${id}"]`)
    if (!el) throw new Error(`no element with testID ${id}`)
    return el
}

export function rowIdsOf(container: HTMLElement, table: string): string[] {
    const prefix = `form-table-${table}-row-`
    return [...container.querySelectorAll(`[testID^="${prefix}"]`)].map(el =>
        (el.getAttribute('testID') ?? '').slice(prefix.length)
    )
}
