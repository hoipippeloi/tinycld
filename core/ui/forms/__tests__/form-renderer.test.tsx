// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bugDefinition, widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema, type FormDefinition } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { evaluate } from '../../../lib/forms/logic'
import { buildSchema } from '../../../lib/forms/values'
import { FormRenderer } from '../FormRenderer'
import { useSchemaRefResolver } from '../use-schema-ref-resolver'

afterEach(cleanup)

const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const ctx = { today: '2026-01-01', userId: 'u' }

// Two pages: Details (name, severity) and Reproduction (steps), with the host's builtins folded in.
const def = definitionSchema.parse({
    ...bugDefinition,
    submit: { required: ['name'] },
    fields: [
        ...defaultDefinitionFor(widgetHost).fields.map(f => ({ ...f, page: 'details' })),
        bugDefinition.fields[1],
        { key: 'steps', kind: 'textarea', page: 'repro', label: 'Steps' },
    ],
})

const defaults = { name: '', severity: 'low' }

const baseFields = [
    ...defaultDefinitionFor(widgetHost).fields.map(f => ({ ...f, page: 'details' })),
    bugDefinition.fields[1],
]

const ruleDef = definitionSchema.parse({
    ...bugDefinition,
    submit: { required: ['name'] },
    fields: [
        ...baseFields,
        { key: 'note', kind: 'text', page: 'details', label: 'Note' },
        { key: 'steps', kind: 'textarea', page: 'repro', label: 'Steps' },
    ],
    rules: [
        {
            key: 'escalate',
            when: [{ field: 'severity', op: 'is', value: 'high' }],
            actions: [{ action: 'set_value', field: 'note', value: 'escalated' }],
        },
        {
            key: 'loaded',
            when: [{ field: 'name', op: 'is', value: 'loaded' }],
            actions: [{ action: 'set_value', field: 'note', value: 'overwritten' }],
        },
        {
            key: 'secret',
            when: [{ field: 'name', op: 'is', value: 'secret' }],
            actions: [{ action: 'hide', field: 'due' }],
        },
    ],
})

const onePageDef = definitionSchema.parse({
    ...bugDefinition,
    submit: { required: ['name'] },
    pages: [{ key: 'details', title: 'Details' }],
    fields: baseFields,
    rules: [],
})

type Form = ReturnType<typeof useForm<Record<string, unknown>>>

function useHarnessForm(definition: FormDefinition, initialValues: Record<string, unknown>) {
    const initial = buildSchema(definition, host, evaluate(definition, initialValues, ctx))
    const { schemaRef, resolver } = useSchemaRefResolver(initial)
    const form = useForm({ defaultValues: initialValues, resolver })
    return { form, schemaRef }
}

interface HarnessProps {
    layout: 'wizard' | 'sections'
    definition?: FormDefinition
    initialValues?: Record<string, unknown>
    onSubmit?: () => void
    recordId?: string
    readOnly?: boolean
    formRef?: { current: Form | null }
}

function Harness(props: HarnessProps) {
    const { layout, definition = def, initialValues = defaults, formRef } = props
    const { form, schemaRef } = useHarnessForm(definition, initialValues)
    if (formRef) formRef.current = form
    return (
        <FormRenderer
            host={host}
            ui={null}
            definition={definition}
            layout={layout}
            form={form}
            schemaRef={schemaRef}
            context={ctx}
            onSubmit={props.onSubmit}
            recordId={props.recordId}
            readOnly={props.readOnly}
        />
    )
}

function DesignHarness({ onSelect }: { onSelect: (key: string) => void }) {
    const { form, schemaRef } = useHarnessForm(def, defaults)
    return (
        <FormRenderer
            host={host}
            ui={null}
            definition={def}
            layout="design"
            form={form}
            schemaRef={schemaRef}
            context={ctx}
            design={{
                selectedKey: 'severity',
                onSelect,
                renderHandle: key => <span data-testid={`handle-${key}`}>::</span>,
            }}
        />
    )
}

function byTestId(container: HTMLElement, id: string) {
    return container.querySelector(`[testID="${id}"]`)
}

describe('FormRenderer sections', () => {
    it('renders every page title and every visible field', () => {
        const { getByText, container } = render(<Harness layout="sections" />)
        expect(getByText('Details')).toBeTruthy()
        expect(getByText('Reproduction')).toBeTruthy()
        expect(byTestId(container, 'form-field-name')).toBeTruthy()
        expect(byTestId(container, 'form-field-steps')).toBeTruthy()
    })
    it('marks steps required when severity becomes high', async () => {
        const { getByText, container } = render(<Harness layout="sections" />)
        expect(byTestId(container, 'form-field-steps')?.textContent).not.toContain('*')
        fireEvent.click(getByText('High'))
        await waitFor(() =>
            expect(byTestId(container, 'form-field-steps')?.textContent).toContain('*')
        )
    })
})

describe('FormRenderer wizard', () => {
    it('shows one page at a time and blocks Next on a page error', async () => {
        const onSubmit = vi.fn()
        const { getByText, container } = render(<Harness layout="wizard" onSubmit={onSubmit} />)
        expect(byTestId(container, 'form-field-name')).toBeTruthy()
        expect(byTestId(container, 'form-field-steps')).toBeNull()
        fireEvent.click(byTestId(container, 'form-wizard-next') as Element)
        await waitFor(() =>
            expect(byTestId(container, 'form-field-name')?.textContent).toContain('required')
        )
        expect(byTestId(container, 'form-field-steps')).toBeNull()
        const input = byTestId(container, 'form-input-name') as HTMLInputElement
        fireEvent.input(input, { target: { value: 'Login fails' } })
        fireEvent.click(byTestId(container, 'form-wizard-next') as Element)
        await waitFor(() => expect(byTestId(container, 'form-field-steps')).toBeTruthy())
        fireEvent.click(getByText('Create'))
        await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    })
})

describe('FormRenderer design', () => {
    it('renders inert cells with the handle and selection', () => {
        const onSelect = vi.fn()
        const { getByTestId, container } = render(<DesignHarness onSelect={onSelect} />)
        expect(getByTestId('handle-severity')).toBeTruthy()
        expect(byTestId(container, 'form-field-severity')?.getAttribute('class')).toContain(
            'border-primary'
        )
        fireEvent.click(byTestId(container, 'form-field-name') as Element)
        expect(onSelect).toHaveBeenCalledWith('name')
    })
})

describe('FormRenderer wizard navigation', () => {
    it('goes back to the previous page', async () => {
        const { container } = render(<Harness layout="wizard" />)
        const input = byTestId(container, 'form-input-name') as HTMLInputElement
        fireEvent.input(input, { target: { value: 'Login fails' } })
        fireEvent.click(byTestId(container, 'form-wizard-next') as Element)
        await waitFor(() => expect(byTestId(container, 'form-field-steps')).toBeTruthy())
        fireEvent.click(byTestId(container, 'form-wizard-back') as Element)
        await waitFor(() => expect(byTestId(container, 'form-field-name')).toBeTruthy())
        expect(byTestId(container, 'form-field-steps')).toBeNull()
    })
    it('shows no steps for a one-page form', () => {
        const { container } = render(<Harness layout="wizard" definition={onePageDef} />)
        expect(byTestId(container, 'form-wizard-steps')).toBeNull()
        expect(byTestId(container, 'form-field-name')).toBeTruthy()
    })
})

describe('FormRenderer rules and modes', () => {
    it('applies set_value when its rule becomes active after mount', async () => {
        const formRef = { current: null as Form | null }
        const { getByText } = render(
            <Harness layout="sections" definition={ruleDef} formRef={formRef} />
        )
        fireEvent.click(getByText('High'))
        await waitFor(() => expect(formRef.current?.getValues('note')).toBe('escalated'))
    })
    it('does not apply a set_value rule that is already active on mount in edit mode', async () => {
        const formRef = { current: null as Form | null }
        render(
            <Harness
                layout="sections"
                definition={ruleDef}
                recordId="rec1"
                initialValues={{ name: 'loaded', severity: 'low', note: 'kept' }}
                formRef={formRef}
            />
        )
        await new Promise(r => setTimeout(r, 20))
        expect(formRef.current?.getValues('note')).toBe('kept')
    })
    it('disables inputs in read-only mode', () => {
        const editable = render(<Harness layout="sections" recordId="rec1" />)
        expect(byTestId(editable.container, 'form-input-name')?.hasAttribute('editable')).toBe(true)
        cleanup()
        const { container } = render(<Harness layout="sections" readOnly recordId="rec1" />)
        expect(byTestId(container, 'form-input-name')?.hasAttribute('editable')).toBe(false)
    })
    it('unmounts a field hidden by a rule but keeps its value', async () => {
        const formRef = { current: null as Form | null }
        const { container } = render(
            <Harness
                layout="sections"
                definition={ruleDef}
                initialValues={{ name: '', severity: 'low', due: '2026-02-02' }}
                formRef={formRef}
            />
        )
        expect(byTestId(container, 'form-field-due')).toBeTruthy()
        fireEvent.input(byTestId(container, 'form-input-name') as Element, {
            target: { value: 'secret' },
        })
        await waitFor(() => expect(byTestId(container, 'form-field-due')).toBeNull())
        expect(formRef.current?.getValues('due')).toBe('2026-02-02')
    })
})
