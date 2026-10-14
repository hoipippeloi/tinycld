// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render as renderBare } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { RulesTab } from '../RulesTab'
import { useEditorForm } from '../use-editor-form'

// The rule menus render through the overlay host.
const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

afterEach(cleanup)
const base = defaultDefinitionFor(widgetHost)
const def = {
    ...base,
    fields: [
        ...base.fields,
        newCustomField('select', 'Severity', 'main', new Set()),
        newCustomField('text', 'Steps', 'main', new Set()),
    ],
}
const plain = {
    id: 'f1',
    host: 'gizmos:widget',
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: def,
}
const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const admin = {
    host,
    forms: [plain],
    defaultForm: plain,
    isReady: true,
    saveDefinition: { mutateAsync: vi.fn(), isPending: false },
}
vi.mock('../../../lib/forms/use-form-admin', async importOriginal => ({
    ...(await importOriginal<object>()),
    useFormAdmin: () => admin,
}))
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: plain, isReady: true }),
    useFormsOfHost: () => ({ forms: [plain], defaultForm: plain, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => host }))
vi.mock('@tinycld/core/components/workspace/useBreakpoint', () => ({
    useBreakpoint: () => 'desktop',
}))
// RN stub hosts carry `testID`; Menu rows are DOM elements with `data-testid`
// under the overlay host, outside the render container.
const q = (_c: ParentNode, id: string) =>
    document.body.querySelector(`[testID="${id}"], [data-testid="${id}"]`) as HTMLElement | null

let editorRef: ReturnType<typeof useEditorForm> | null = null
function Harness() {
    const editor = useEditorForm('f1')
    editorRef = editor
    return <RulesTab editor={editor} isVisible />
}

describe('RulesTab', () => {
    it('shows the empty hint and adds a rule with one empty condition and action row', () => {
        const { container, getByText } = render(<Harness />)
        expect(getByText(/no rules yet/i)).toBeTruthy()
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        expect(editorRef?.form.getValues('rules')).toHaveLength(1)
        expect(q(container, 'form-rule-0')).toBeTruthy()
    })
    it('authors "when severity is high then require steps"', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0-severity') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-op-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-op-0-0-is') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-value-0-0-option_1') as HTMLElement)
        fireEvent.click(q(container, 'form-action-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-steps') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0-require') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0')).toEqual({
            key: 'rule',
            match: 'all',
            when: [{ field: 'severity', op: 'is', value: 'option_1' }],
            actions: [{ action: 'require', field: 'steps' }],
        })
    })
    it('offers set_options only for a select target', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-action-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-steps') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        expect(q(container, 'form-action-kind-0-0-set_options')).toBeNull()
        // A real click's pointerdown outside the open menu dismisses it; fireEvent.click alone does not.
        fireEvent.pointerDown(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-severity') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        expect(q(container, 'form-action-kind-0-0-set_options')).toBeTruthy()
    })
    it('removes a rule', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-rule-remove-0') as HTMLElement)
        expect(editorRef?.form.getValues('rules')).toHaveLength(0)
    })
    it('keeps a later rule intact when an earlier one is removed', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-add-1') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-1-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-1-0-severity') as HTMLElement)
        fireEvent.click(q(container, 'form-rule-remove-0') as HTMLElement)
        expect(editorRef?.form.getValues('rules')).toHaveLength(1)
        expect(q(container, 'form-cond-field-0-0')?.textContent).toContain('Severity')
        expect(q(container, 'form-cond-field-1-0')).toBeNull()
    })
    it('resets the operator and value when the condition field changes', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0-severity') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-value-0-0-option_1') as HTMLElement)
        fireEvent.pointerDown(q(container, 'form-cond-field-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-cond-field-0-0-steps') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.when.0')).toEqual({
            field: 'steps',
            op: 'eq',
            value: undefined,
        })
    })
    it('marks the fields the selected rule reads and changes', () => {
        const { container } = render(<Harness />)
        act(() =>
            editorRef?.apply(d => ({
                ...d,
                rules: [
                    {
                        key: 'r1',
                        match: 'all',
                        when: [{ field: 'severity', op: 'is', value: 'option_1' }],
                        actions: [{ action: 'require', field: 'steps' }],
                    },
                ],
            }))
        )
        const pane = q(container, 'form-rule-affected')
        expect(pane?.textContent).toContain('when')
        expect(pane?.textContent).toContain('Require')
    })
    it('seeds set_options from the target and lets set_value pick an option', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-action-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-severity') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0-set_options') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.actions.0')).toEqual({
            action: 'set_options',
            field: 'severity',
            options: [{ value: 'option_1', label: 'Option 1' }],
        })
        fireEvent.click(q(container, 'form-action-option-add-0-0') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.actions.0')).toMatchObject({
            options: [
                { value: 'option_1', label: 'Option 1' },
                { value: 'option_2', label: 'Option 2' },
            ],
        })
        fireEvent.pointerDown(q(container, 'form-action-kind-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0-set_value') as HTMLElement)
        fireEvent.click(q(container, 'form-action-value-0-0-option_1') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.actions.0')).toEqual({
            action: 'set_value',
            field: 'severity',
            value: 'option_1',
        })
    })
    it('falls back to show when a page becomes the target of a require', () => {
        const { container } = render(<Harness />)
        fireEvent.click(q(container, 'form-rule-add') as HTMLElement)
        fireEvent.click(q(container, 'form-action-add-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-kind-0-0-require') as HTMLElement)
        fireEvent.pointerDown(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-page:main') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.actions.0')).toEqual({
            action: 'show',
            page: 'main',
        })
    })
    it('reseeds set_options rows when the target changes', () => {
        const { container } = render(<Harness />)
        act(() =>
            editorRef?.apply(d => ({
                ...d,
                fields: [...d.fields, newCustomField('select', 'Priority', 'main', new Set())],
                rules: [
                    {
                        key: 'r1',
                        match: 'all',
                        when: [],
                        actions: [
                            {
                                action: 'set_options',
                                field: 'severity',
                                options: [
                                    { value: 'a', label: 'A' },
                                    { value: 'b', label: 'B' },
                                ],
                            },
                        ],
                    },
                ],
            }))
        )
        expect(q(container, 'form-action-option-remove-0-0-1')).toBeTruthy()
        fireEvent.click(q(container, 'form-action-target-0-0') as HTMLElement)
        fireEvent.click(q(container, 'form-action-target-0-0-priority') as HTMLElement)
        expect(editorRef?.form.getValues('rules.0.actions.0')).toEqual({
            action: 'set_options',
            field: 'priority',
            options: [{ value: 'option_1', label: 'Option 1' }],
        })
        expect(q(container, 'form-action-option-remove-0-0-1')).toBeNull()
    })
})
