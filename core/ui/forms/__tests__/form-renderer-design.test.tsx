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
                    draggingKey: 'name',
                    dropTarget: { key: 'severity', side: 'after' },
                    badges: { severity: <Text>when</Text> },
                }}
            />
        )
        expect(q(container, 'form-field-severity-drop-after')).toBeTruthy()
        expect(q(container, 'form-field-severity-drop-before')).toBeNull()
        expect(q(container, 'form-field-severity')?.textContent).toContain('when')
    })

    it('draws no drop indicator without a drag in progress', () => {
        const { container } = render(
            <Design
                design={{
                    dropTarget: { page: 'repro', end: true },
                }}
            />
        )
        expect(container.querySelector('[data-testid*="-drop-"]')).toBeNull()
    })

    it('dims the dragged cell and still marks its own edge, so the bar never vanishes', () => {
        const { container } = render(
            <Design
                design={{
                    draggingKey: 'severity',
                    dropTarget: { key: 'severity', side: 'before' },
                }}
            />
        )
        expect(q(container, 'form-field-severity')?.getAttribute('class')).toContain('opacity-50')
        expect(q(container, 'form-field-severity-drop-before')).toBeTruthy()
        expect(q(container, 'form-field-name')?.getAttribute('class')).not.toContain('opacity-50')
    })

    it('shows a drop bar at the end of a targeted page, under its fields and above its footer', () => {
        const { container, getByText } = render(
            <Design
                design={{
                    draggingKey: 'name',
                    dropTarget: { page: 'repro', end: true },
                    renderPageFooter: p => <Text>{`F:${p.key}`}</Text>,
                }}
            />
        )
        const bar = q(container, 'form-page-repro-drop-end') as HTMLElement
        expect(bar).toBeTruthy()
        expect(q(container, 'form-page-details-drop-end')).toBeNull()
        const steps = q(container, 'form-field-steps') as HTMLElement
        const footer = getByText('F:repro')
        const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
        expect(steps.compareDocumentPosition(bar) & FOLLOWING).toBeTruthy()
        expect(bar.compareDocumentPosition(footer) & FOLLOWING).toBeTruthy()
        // Zero height: the footer does not move when the bar appears.
        expect(bar.parentElement?.getAttribute('class')).toContain('h-0')
    })

    it('makes the cell itself the pressable, so it keeps its width basis', () => {
        const onSelect = vi.fn()
        const { container } = render(<Design design={{ onSelect }} />)
        const cell = q(container, 'form-field-severity') as HTMLElement
        expect(cell.tagName.toLowerCase()).toBe('rn-pressable')
        expect(cell.getAttribute('class')).toContain('basis-')
        expect(cell.getAttribute('accessibilityRole')).toBeNull()
        expect(cell.getAttribute('accessibilityLabel')).toBe('Select Severity')
        expect(cell.parentElement?.tagName.toLowerCase()).not.toBe('rn-pressable')
        fireEvent.click(cell)
        expect(onSelect).toHaveBeenCalledWith('severity')
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

    it('registers a re-measure thunk per cell and page once, and unregisters on unmount', async () => {
        const unregisterCell = vi.fn()
        const unregisterPage = vi.fn()
        const onCellMeasure = vi.fn<(key: string, m: () => Promise<unknown>) => () => void>(
            () => unregisterCell
        )
        const onPageMeasure = vi.fn<(key: string, m: () => Promise<unknown>) => () => void>(
            () => unregisterPage
        )
        const { container, rerender, unmount } = render(
            <Design design={{ onCellMeasure, onPageMeasure }} />
        )
        const cellKeys = def.fields.map(f => f.key)
        expect(onCellMeasure.mock.calls.map(([key]) => key)).toEqual(cellKeys)
        expect(onPageMeasure.mock.calls.map(([key]) => key)).toEqual(def.pages.map(p => p.key))
        rerender(<Design design={{ onCellMeasure, onPageMeasure, selectedKey: 'severity' }} />)
        expect(onCellMeasure).toHaveBeenCalledTimes(cellKeys.length)

        const node = q(container, 'form-field-severity') as Measurable
        node.measureInWindow = cb => cb(9, 8, 7, 6)
        const measure = onCellMeasure.mock.calls.find(([key]) => key === 'severity')?.[1]
        await expect(measure?.()).resolves.toEqual({ x: 9, y: 8, width: 7, height: 6 })

        unmount()
        expect(unregisterCell).toHaveBeenCalledTimes(cellKeys.length)
        expect(unregisterPage).toHaveBeenCalledTimes(def.pages.length)
        await expect(measure?.()).resolves.toBeNull()
    })
})
