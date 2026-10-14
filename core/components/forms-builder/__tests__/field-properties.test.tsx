// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render as renderBare } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { FieldProperties } from '../FieldProperties'
import { useEditorForm } from '../use-editor-form'

// The default picker's Menu and the delete confirm render through the overlay host.
const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

afterEach(cleanup)
const base = defaultDefinitionFor(widgetHost)
const withSelect = {
    ...base,
    fields: [
        ...base.fields,
        newCustomField('select', 'Severity', 'main', new Set()),
        newCustomField('toggle', 'Flag', 'main', new Set()),
        newCustomField('number', 'Count', 'main', new Set()),
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
    definition: withSelect,
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
// RN stub hosts carry `testID`; Menu rows are DOM elements with `data-testid`.
const q = (c: ParentNode, id: string) =>
    c.querySelector(`[testID="${id}"], [data-testid="${id}"]`) as HTMLElement | null
// The RN stub renders aria-disabled={true} as an empty attribute and {false} as "false".
const isDisabled = (el: HTMLElement | null) => {
    const value = el?.getAttribute('aria-disabled')
    return value !== null && value !== undefined && value !== 'false'
}

let editorRef: ReturnType<typeof useEditorForm> | null = null
function Harness({ fieldKey }: { fieldKey: string }) {
    const editor = useEditorForm('f1')
    editorRef = editor
    return <FieldProperties editor={editor} fieldKey={fieldKey} />
}

describe('FieldProperties', () => {
    it('shows label, key read-only, kind locked, width and required for a custom select, with its options', () => {
        const { container, getByText } = render(<Harness fieldKey="severity" />)
        expect((q(container, 'fields.6.label') as HTMLInputElement).value).toBe('Severity')
        expect(q(container, 'form-prop-key')?.textContent).toContain('severity')
        expect(q(container, 'form-prop-kind')?.textContent).toContain('Choice list')
        expect(getByText('Options')).toBeTruthy()
        expect(q(container, 'form-option-add')).toBeTruthy()
    })
    it('renaming changes the label but not the key', () => {
        const { container } = render(<Harness fieldKey="severity" />)
        fireEvent.input(q(container, 'fields.6.label') as HTMLElement, {
            target: { value: 'Sev' },
        })
        expect(editorRef?.form.getValues('fields.6.label')).toBe('Sev')
        expect(editorRef?.form.getValues('fields.6.key')).toBe('severity')
    })
    it('locks hidden for a host-required builtin and offers no delete', () => {
        const { container } = render(<Harness fieldKey="name" />)
        expect(isDisabled(q(container, 'fields.0.hidden'))).toBe(true)
        expect(q(container, 'form-prop-delete')).toBeNull()
    })
    it('leaves hidden unlocked for a custom field', () => {
        const { container } = render(<Harness fieldKey="severity" />)
        expect(isDisabled(q(container, 'fields.6.hidden'))).toBe(false)
    })
    it('deletes a custom field after confirm and clears selection', async () => {
        const { container, getByText } = render(<Harness fieldKey="severity" />)
        act(() => editorRef?.select('severity'))
        fireEvent.click(q(container, 'form-prop-delete') as HTMLElement)
        fireEvent.click(getByText('Delete'))
        await act(async () => {})
        expect(editorRef?.form.getValues('fields').some(f => f.key === 'severity')).toBe(false)
        expect(editorRef?.selectedKey).toBeNull()
    })
    it('names what the delete also removes', () => {
        const { container, getByText } = render(<Harness fieldKey="severity" />)
        act(() =>
            editorRef?.apply(def => ({
                ...def,
                defaults: { severity: 'option_1' },
                rules: [
                    {
                        key: 'r1',
                        match: 'all',
                        when: [{ field: 'severity', op: 'is', value: 'option_1' }],
                        actions: [{ action: 'hide', field: 'due' }],
                    },
                ],
            }))
        )
        fireEvent.click(q(container, 'form-prop-delete') as HTMLElement)
        expect(
            getByText(
                'Stored values stay in the records, hidden. This also removes 1 rule, its default.'
            )
        ).toBeTruthy()
    })
    it('adds an option row', () => {
        const { container } = render(<Harness fieldKey="severity" />)
        fireEvent.click(q(container, 'form-option-add') as HTMLElement)
        expect(editorRef?.form.getValues('fields.6.options')).toHaveLength(2)
    })
    it('adds an option whose value is not taken yet', () => {
        const { container } = render(<Harness fieldKey="severity" />)
        fireEvent.input(q(container, 'fields.6.options.0.value') as HTMLElement, {
            target: { value: 'option_2' },
        })
        fireEvent.click(q(container, 'form-option-add') as HTMLElement)
        fireEvent.click(q(container, 'form-option-add') as HTMLElement)
        expect(editorRef?.form.getValues('fields.6.options')?.map(o => o.value)).toEqual([
            'option_2',
            'option_1',
            'option_3',
        ])
    })
    it('moves an option down', () => {
        const { container } = render(<Harness fieldKey="severity" />)
        fireEvent.click(q(container, 'form-option-add') as HTMLElement)
        fireEvent.click(q(container, 'form-option-down-0') as HTMLElement)
        expect(editorRef?.form.getValues('fields.6.options')?.map(o => o.value)).toEqual([
            'option_2',
            'option_1',
        ])
    })
})

describe('DefaultPicker', () => {
    const pick = (container: HTMLElement, id: string) => {
        fireEvent.click(q(container, 'form-default-mode') as HTMLElement)
        fireEvent.click(q(document.body, id) as HTMLElement)
    }
    it('sets a date default to today', () => {
        const { container } = render(<Harness fieldKey="due" />)
        pick(container, 'form-default-today')
        expect(editorRef?.form.getValues('defaults')).toEqual({ due: { today: [] } })
        expect(q(container, 'form-default-mode')?.textContent).toBe('Today')
    })
    it('offers On and Off for a toggle instead of a typed value', () => {
        const { container } = render(<Harness fieldKey="flag" />)
        pick(container, 'form-default-on')
        expect(editorRef?.form.getValues('defaults')).toEqual({ flag: true })
        expect(q(container, 'form-default-value')).toBeNull()
        expect(q(container, 'form-default-mode')?.textContent).toBe('On')
    })
    it('types a number default as a number when the input loses focus', () => {
        const { container } = render(<Harness fieldKey="count" />)
        pick(container, 'form-default-literal')
        const input = q(container, 'form-default-value') as HTMLElement
        fireEvent.input(input, { target: { value: '1.5' } })
        expect(editorRef?.form.getValues('defaults')).toEqual({ count: '1.5' })
        fireEvent.blur(input)
        expect(editorRef?.form.getValues('defaults')).toEqual({ count: 1.5 })
    })
    it('lets the days field be cleared and retyped', () => {
        const { container } = render(<Harness fieldKey="due" />)
        pick(container, 'form-default-today_plus')
        const days = q(container, 'form-default-days') as HTMLInputElement
        fireEvent.input(days, { target: { value: '' } })
        expect(days.value).toBe('')
        expect(editorRef?.form.getValues('defaults')).toEqual({
            due: { addDays: [{ today: [] }, 0] },
        })
        fireEvent.input(days, { target: { value: '3' } })
        expect(editorRef?.form.getValues('defaults')).toEqual({
            due: { addDays: [{ today: [] }, 3] },
        })
    })
    it('shows a default error under the picker', async () => {
        const { container, getByText } = render(<Harness fieldKey="count" />)
        act(() => editorRef?.apply(def => ({ ...def, defaults: { count: 'abc' } })))
        await act(async () => {
            await editorRef?.save()
        })
        expect(getByText('Count default must be a number')).toBeTruthy()
        expect(q(container, 'form-default-mode')?.getAttribute('accessibilityLabel')).toBe(
            'Default: A value'
        )
    })
    it('removes the default when No default is chosen', () => {
        const { container } = render(<Harness fieldKey="due" />)
        pick(container, 'form-default-today')
        pick(container, 'form-default-none')
        expect(editorRef?.form.getValues('defaults')).toEqual({})
    })
})
