// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render as renderBare } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { Canvas } from '../Canvas'
import { useEditorForm } from '../use-editor-form'

// The kind picker's Menu renders through the overlay host the app mounts once.
const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

afterEach(cleanup)

const plain = {
    id: 'f1',
    host: 'gizmos:widget',
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: defaultDefinitionFor(widgetHost),
}
const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const admin = {
    host,
    forms: [plain],
    defaultForm: plain,
    isReady: true,
    saveDefinition: { mutateAsync: vi.fn(async () => {}), isPending: false },
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
const isDisabled = (el: HTMLElement | null) => Boolean(el?.hasAttribute('aria-disabled'))
const ctx = { today: '2026-01-01', userId: 'u' }

let editor: ReturnType<typeof useEditorForm> | null = null
function Harness() {
    editor = useEditorForm('f1')
    return <Canvas editor={editor} context={ctx} />
}

type Measurable = HTMLElement & { measureInWindow?: (cb: (...n: number[]) => void) => void }

function measureThenLayout(el: HTMLElement | null, rect: number[]) {
    const node = el as Measurable
    node.measureInWindow = cb => cb(...rect)
    fireEvent(node, new CustomEvent('rn-layout', { detail: { width: 1, height: 1, x: 0, y: 0 } }))
}

/** Stacks the builtin cells 40px apart in one 400px-wide page. */
function layOutCells(container: HTMLElement) {
    const keys = plain.definition.fields.map(f => f.key)
    measureThenLayout(q(container, 'form-page-main'), [0, 0, 400, keys.length * 40 + 80])
    keys.forEach((key, i) => {
        measureThenLayout(q(container, `form-field-${key}`), [0, i * 40, 400, 40])
    })
}

function pointer(type: string, target: Element | Window, x: number, y: number) {
    fireEvent(
        target,
        new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y })
    )
}

function addSelectField(baseElement: HTMLElement) {
    fireEvent.click(q(baseElement, 'form-add-field-main') as HTMLElement)
    fireEvent.click(q(baseElement, 'form-kind-select') as HTMLElement)
}

describe('Canvas', () => {
    it('renders every builtin with a handle and selects on press', () => {
        const { container } = render(<Harness />)
        for (const f of plain.definition.fields)
            expect(q(container, `form-handle-${f.key}`)).toBeTruthy()
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        expect(q(container, 'form-field-due')?.getAttribute('class')).toContain('border-primary')
    })

    it('adds a field of the picked kind at the end of the page and selects it', () => {
        const { baseElement } = render(<Harness />)
        addSelectField(baseElement)
        const added = q(baseElement, 'form-field-new_field')
        expect(added).toBeTruthy()
        expect(added?.getAttribute('class')).toContain('border-primary')
        expect(editor?.form.getValues('fields').at(-1)).toMatchObject({
            key: 'new_field',
            kind: 'select',
            page: 'main',
        })
    })

    it('adds a page and disables deleting a page that has fields', () => {
        const { container } = render(<Harness />)
        expect(isDisabled(q(container, 'form-page-delete-main'))).toBe(true)
        fireEvent.click(q(container, 'form-add-page') as HTMLElement)
        expect(q(container, 'form-page-new_page')).toBeTruthy()
        expect(isDisabled(q(container, 'form-page-delete-main'))).toBe(true)
        expect(isDisabled(q(container, 'form-page-delete-new_page'))).toBe(false)
        fireEvent.click(q(container, 'form-page-delete-main') as HTMLElement)
        expect(q(container, 'form-page-main')).toBeTruthy()
        fireEvent.click(q(container, 'form-page-delete-new_page') as HTMLElement)
        expect(q(container, 'form-page-new_page')).toBeNull()
    })

    it('renames a page on blur and ignores an empty title', () => {
        const { container } = render(<Harness />)
        const title = q(container, 'form-page-title-main') as HTMLInputElement
        fireEvent.input(title, { target: { value: 'Basics' } })
        expect(editor?.form.getValues('pages.0.title')).toBe('Widget')
        fireEvent.blur(title)
        expect(editor?.form.getValues('pages.0.title')).toBe('Basics')
        fireEvent.input(title, { target: { value: '  ' } })
        fireEvent.blur(title)
        expect(editor?.form.getValues('pages.0.title')).toBe('Basics')
    })

    it('drags a cell to the slot under the pointer', () => {
        const { container } = render(<Harness />)
        layOutCells(container)
        const keys = plain.definition.fields.map(f => f.key)
        const last = keys.at(-1) as string
        pointer('pointerdown', q(container, `form-handle-${last}`) as HTMLElement, 10, 10)
        pointer('pointermove', window, 20, 20)
        pointer('pointermove', window, 50, 20)
        expect(q(container, `form-field-${keys[0]}-drop-before`)).toBeTruthy()
        pointer('pointerup', window, 50, 20)
        expect(editor?.form.getValues('fields').map(f => f.key)).toEqual([
            last,
            ...keys.slice(0, -1),
        ])
        expect(q(container, `form-field-${keys[0]}-drop-before`)).toBeNull()
    })

    it('keeps rendering the last valid canvas while a draft is invalid', () => {
        const { baseElement, container } = render(<Harness />)
        addSelectField(baseElement)
        const index = (editor?.form.getValues('fields').length ?? 0) - 1
        act(() => editor?.form.setValue(`fields.${index}.options`, []))
        expect(q(container, 'form-canvas')).toBeTruthy()
        expect(q(container, 'form-field-new_field')).toBeTruthy()
    })
})
