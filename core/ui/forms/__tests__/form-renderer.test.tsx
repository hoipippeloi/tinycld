// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bugDefinition, widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
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

function useHarnessForm() {
    const initial = buildSchema(def, host, evaluate(def, defaults, ctx))
    const { schemaRef, resolver } = useSchemaRefResolver(initial)
    const form = useForm({ defaultValues: defaults, resolver })
    return { form, schemaRef }
}

function Harness({ layout, onSubmit }: { layout: 'wizard' | 'sections'; onSubmit?: () => void }) {
    const { form, schemaRef } = useHarnessForm()
    return (
        <FormRenderer
            host={host}
            ui={null}
            definition={def}
            layout={layout}
            form={form}
            schemaRef={schemaRef}
            context={ctx}
            onSubmit={onSubmit}
        />
    )
}

function DesignHarness({ onSelect }: { onSelect: (key: string) => void }) {
    const { form, schemaRef } = useHarnessForm()
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
