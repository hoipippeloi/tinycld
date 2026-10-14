// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import type { FormField } from '../../../lib/forms/definition'
import type { FormValues } from '../../../lib/forms/logic'
import { FieldInput } from '../FieldInput'

afterEach(cleanup)

const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }

function Harness({
    field,
    mode = 'create',
}: {
    field: FormField
    mode?: 'create' | 'edit' | 'read' | 'design'
}) {
    const { control } = useForm<FormValues>({
        defaultValues: { [field.key]: field.kind === 'number' ? 0 : '' },
    })
    return <FieldInput host={host} ui={null} field={field} control={control} mode={mode} />
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

    it('renders nothing for a section in create mode', () => {
        const { container } = render(
            <Harness field={{ ...base, key: 'comments', kind: 'builtin' }} />
        )
        expect(container.querySelector('[testID="form-input-comments"]')).toBeNull()
    })

    it('shows the empty read view for a collaborative builtin in read mode', () => {
        const { getByText } = render(
            <Harness field={{ ...base, key: 'notes', kind: 'builtin' }} mode="read" />
        )
        expect(getByText('Empty')).toBeTruthy()
    })
})
