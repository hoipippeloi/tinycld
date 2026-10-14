// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useForm, useWatch } from 'react-hook-form'
import { Text } from 'react-native'
import { afterEach, describe, expect, it } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import type { FormField } from '../../../lib/forms/definition'
import type { CollabDoc, FormHostUi } from '../../../lib/forms/host-ui'
import type { FormValues } from '../../../lib/forms/logic'
import { FieldInput } from '../FieldInput'

afterEach(cleanup)

const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }

function Harness({
    field,
    mode = 'create',
    ui = null,
    recordId,
    collab,
    initial,
}: {
    field: FormField
    mode?: 'create' | 'edit' | 'read' | 'design'
    ui?: FormHostUi | null
    recordId?: string
    collab?: CollabDoc | null
    initial?: unknown
}) {
    const { control } = useForm<FormValues>({
        defaultValues: { [field.key]: initial ?? (field.kind === 'number' ? 0 : '') },
    })
    const value = useWatch({ control, name: field.key })
    return (
        <>
            <Text testID="value">{String(value)}</Text>
            <FieldInput
                host={host}
                ui={ui}
                field={field}
                control={control}
                mode={mode}
                recordId={recordId}
                collab={collab}
            />
        </>
    )
}

function byTestId(container: HTMLElement, id: string) {
    const el = container.querySelector(`[testID="${id}"]`)
    if (!el) throw new Error(`no element with testID ${id}`)
    return el
}

const select = {
    key: 's',
    kind: 'select' as const,
    multiple: false,
    options: [{ value: 'x', label: 'Ex' }],
}

const base = { page: 'main', label: 'L', width: 'full' as const, required: false, hidden: false }

describe('FieldInput', () => {
    it('renders a text input for text', () => {
        const { container } = render(<Harness field={{ ...base, key: 'a', kind: 'text' }} />)
        expect(container.querySelector('rn-textinput')).toBeTruthy()
    })

    it('renders radio options for select with display radio', () => {
        const { getByText } = render(
            <Harness
                field={{
                    ...base,
                    key: 's',
                    kind: 'select',
                    display: 'radio',
                    multiple: false,
                    options: [{ value: 'x', label: 'Ex' }],
                }}
            />
        )
        expect(getByText('Ex')).toBeTruthy()
    })

    it('renders a host section in edit mode and nothing in create mode', () => {
        const ui: FormHostUi = {
            components: { CommentsSection: () => <Text>Comments body</Text> },
            mappers: {},
        }
        const field: FormField = { ...base, key: 'comments', kind: 'builtin' }
        const edit = render(<Harness field={field} ui={ui} mode="edit" recordId="r1" />)
        expect(edit.queryByText('Comments body')).toBeTruthy()
        cleanup()
        const create = render(<Harness field={field} ui={ui} mode="create" />)
        expect(create.queryByText('Comments body')).toBeNull()
    })

    it('shows the empty read view for a collaborative builtin in read mode', () => {
        const { getByText } = render(
            <Harness field={{ ...base, key: 'notes', kind: 'builtin' }} mode="read" />
        )
        expect(getByText('Empty')).toBeTruthy()
    })

    it('is read-only for a collaborative field in edit mode with no room', () => {
        const field: FormField = { ...base, key: 'notes', kind: 'builtin' }
        const editable = render(<Harness field={field} mode="create" />)
        const editableCount = editable.container.querySelectorAll(
            '[accessibilityLabel="Edit text"]'
        ).length
        cleanup()
        const noRoom = render(<Harness field={field} mode="edit" recordId="r1" collab={null} />)
        const noRoomCount = noRoom.container.querySelectorAll(
            '[accessibilityLabel="Edit text"]'
        ).length
        expect(editableCount).toBeGreaterThan(0)
        expect(noRoomCount).toBe(0)
    })

    it('asks to add files after creating when a file field has no record', () => {
        const { getByText } = render(
            <Harness
                field={{ ...base, key: 'f', kind: 'file', multiple: true, accept: [] }}
                mode="create"
            />
        )
        expect(getByText('Add files after creating.')).toBeTruthy()
    })

    it.each([
        'dropdown',
        'radio',
    ] as const)('does not change a %s value in read mode, and does in create mode', display => {
        const field: FormField = { ...base, ...select, display }
        const read = render(<Harness field={field} mode="read" />)
        fireEvent.click(read.getByText('Ex'))
        expect(byTestId(read.container, 'value').textContent).toBe('')
        cleanup()
        const create = render(<Harness field={field} mode="create" />)
        fireEvent.click(create.getByText('Ex'))
        expect(byTestId(create.container, 'value').textContent).toBe('x')
    })

    it('disables the number input in read mode and gives it the form test id', () => {
        const field: FormField = { ...base, key: 'n', kind: 'number' }
        const editableOf = (container: HTMLElement) =>
            byTestId(container, 'form-input-n').hasAttribute('editable')
        const read = render(<Harness field={field} mode="read" />)
        // The stub drops a false boolean prop and writes a true one as an attribute.
        expect(editableOf(read.container)).toBe(false)
        cleanup()
        const create = render(<Harness field={field} mode="create" />)
        expect(editableOf(create.container)).toBe(true)
    })
})
