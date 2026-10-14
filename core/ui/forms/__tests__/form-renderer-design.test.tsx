// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bugDefinition, widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { FormRenderer } from '../FormRenderer'

afterEach(cleanup)
const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const ctx = { today: '2026-01-01', userId: 'u' }
const def = definitionSchema.parse({
    ...bugDefinition,
    submit: { required: ['name'] },
    fields: [
        ...defaultDefinitionFor(widgetHost).fields.map(f => ({ ...f, page: 'details' })),
        bugDefinition.fields[1],
        { key: 'steps', kind: 'textarea', page: 'repro', label: 'Steps' },
    ],
})
const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null

function Design(props: { design: Parameters<typeof FormRenderer>[0]['design'] }) {
    const form = useForm({ defaultValues: {} })
    return (
        <FormRenderer
            host={host}
            ui={null}
            definition={def}
            layout="design"
            form={form}
            context={ctx}
            design={props.design}
        />
    )
}

type Measurable = HTMLElement & { measureInWindow?: (cb: (...n: number[]) => void) => void }

function measureThenLayout(el: HTMLElement | null, rect: number[]) {
    const node = el as Measurable
    node.measureInWindow = cb => cb(...rect)
    fireEvent(node, new CustomEvent('rn-layout', { detail: { width: 1, height: 1, x: 0, y: 0 } }))
}

describe('FormRenderer design extensions', () => {
    it('renders page headers and footers through the design options', () => {
        const { getByText } = render(
            <Design
                design={{
                    renderPageHeader: p => <Text>{`H:${p.key}`}</Text>,
                    renderPageFooter: p => <Text>{`F:${p.key}`}</Text>,
                }}
            />
        )
        expect(getByText('H:details')).toBeTruthy()
        expect(getByText('F:repro')).toBeTruthy()
    })

    it('shows a drop indicator on the targeted cell and a badge', () => {
        const { container } = render(
            <Design
                design={{
                    dropTarget: { key: 'severity', side: 'after' },
                    badges: { severity: <Text>when</Text> },
                }}
            />
        )
        expect(q(container, 'form-field-severity-drop-after')).toBeTruthy()
        expect(q(container, 'form-field-severity-drop-before')).toBeNull()
        expect(q(container, 'form-field-severity')?.textContent).toContain('when')
    })

    it('shows a drop bar at the end of a targeted page', () => {
        const { container } = render(
            <Design design={{ dropTarget: { page: 'repro', end: true } }} />
        )
        expect(q(container, 'form-page-repro-drop-end')).toBeTruthy()
        expect(q(container, 'form-page-details-drop-end')).toBeNull()
    })

    it('shows an error under a cell in design mode', () => {
        const { getByText } = render(<Design design={{ errors: { severity: 'needs options' } }} />)
        expect(getByText('needs options')).toBeTruthy()
    })

    it('reports cell and page layouts as measured window rects', () => {
        const onCellLayout = vi.fn()
        const onPageLayout = vi.fn()
        const { container } = render(<Design design={{ onCellLayout, onPageLayout }} />)
        measureThenLayout(q(container, 'form-field-severity'), [1, 2, 3, 4])
        measureThenLayout(q(container, 'form-page-repro'), [5, 6, 7, 8])
        expect(onCellLayout).toHaveBeenCalledWith('severity', { x: 1, y: 2, width: 3, height: 4 })
        expect(onPageLayout).toHaveBeenCalledWith('repro', { x: 5, y: 6, width: 7, height: 8 })
    })
})
