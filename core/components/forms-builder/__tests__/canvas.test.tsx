// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { Canvas, useEditorCanvasDrag } from '../Canvas'
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
let drag: ReturnType<typeof useEditorCanvasDrag> | null = null
function Harness() {
    editor = useEditorForm(plain, host)
    drag = useEditorCanvasDrag(editor)
    return <Canvas editor={editor} context={ctx} drag={drag} />
}

type Measurable = HTMLElement & { measureInWindow?: (cb: (...n: number[]) => void) => void }

function measureThenLayout(el: HTMLElement | null, rect: number[]) {
    const node = el as Measurable
    node.measureInWindow = cb => cb(...rect)
    fireEvent(node, new CustomEvent('rn-layout', { detail: { width: 1, height: 1, x: 0, y: 0 } }))
}

const builtinKeys = plain.definition.fields.map(f => f.key)

/** Stacks the builtin cells 40px apart in one 400px-wide page. */
function layOutCells(container: HTMLElement) {
    measureThenLayout(q(container, 'form-page-main'), [0, 0, 400, builtinKeys.length * 40 + 80])
    builtinKeys.forEach((key, i) => {
        measureThenLayout(q(container, `form-field-${key}`), [0, i * 40, 400, 40])
    })
}

/** Moves the cells in `keys` order without a layout event, as a reorder does on web. */
function moveCellsSilently(container: HTMLElement, keys: string[]) {
    keys.forEach((key, i) => {
        const node = q(container, `form-field-${key}`) as Measurable
        node.measureInWindow = cb => cb(0, i * 40, 400, 40)
    })
}

/** Drags a handle to (x, y), letting the drag-start re-measure settle before hovering. */
async function dragTo(container: HTMLElement, key: string, x: number, y: number) {
    pointer('pointerdown', q(container, `form-handle-${key}`) as HTMLElement, 10, 10)
    await act(async () => pointer('pointermove', window, 20, 20))
    await act(async () => pointer('pointermove', window, x, y))
}

const draftKeys = () => editor?.form.getValues('fields').map(f => f.key)

function pointer(type: string, target: Element | Window, x: number, y: number) {
    fireEvent(
        target,
        new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y })
    )
}

function pickKind(baseElement: HTMLElement, kind: string) {
    fireEvent.click(q(baseElement, 'form-add-field-main') as HTMLElement)
    fireEvent.click(q(baseElement, `form-kind-${kind}`) as HTMLElement)
}

const labelInput = (baseElement: HTMLElement) =>
    baseElement.querySelector(
        'rn-textinput[accessibilityLabel="Field label"]'
    ) as HTMLElement | null

/** Picks a kind, types the label the canvas asks for, and adds the field. */
async function addField(baseElement: HTMLElement, kind: string, label: string) {
    pickKind(baseElement, kind)
    await act(async () => {
        fireEvent.input(labelInput(baseElement) as HTMLElement, { target: { value: label } })
    })
    await act(async () => {
        fireEvent.click(screen.getByText('Add'))
    })
}

describe('Canvas', () => {
    it('renders every builtin with a handle and selects on press', () => {
        const { container } = render(<Harness />)
        for (const f of plain.definition.fields)
            expect(q(container, `form-handle-${f.key}`)).toBeTruthy()
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        expect(q(container, 'form-field-due-box')?.getAttribute('class')).toContain(
            'border-primary'
        )
    })

    it('asks for a label, then adds a field of the picked kind keyed by it and selects it', async () => {
        const { baseElement } = render(<Harness />)
        await addField(baseElement, 'select', 'Severity')
        const added = q(baseElement, 'form-field-severity')
        expect(added).toBeTruthy()
        expect(q(baseElement, 'form-field-severity-box')?.getAttribute('class')).toContain(
            'border-primary'
        )
        expect(editor?.form.getValues('fields').at(-1)).toMatchObject({
            key: 'severity',
            label: 'Severity',
            kind: 'select',
            page: 'main',
        })
    })

    it('adds nothing when the label prompt is cancelled', async () => {
        const { baseElement } = render(<Harness />)
        pickKind(baseElement, 'text')
        expect(labelInput(baseElement)).toBeTruthy()
        await act(async () => {
            fireEvent.click(screen.getByText('Cancel'))
        })
        expect(labelInput(baseElement)).toBeNull()
        expect(draftKeys()).toEqual(builtinKeys)
        expect(editor?.isDirty).toBe(false)
    })

    it('names each drag handle after its field, as a button', () => {
        const { container } = render(<Harness />)
        const handle = q(container, 'form-handle-due') as HTMLElement
        expect(handle.getAttribute('accessibilityRole')).toBe('button')
        expect(handle.getAttribute('accessibilityLabel')).toBe('Drag Due')
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

    it('drags a cell to the slot under the pointer', async () => {
        const { container } = render(<Harness />)
        layOutCells(container)
        const last = builtinKeys.at(-1) as string
        await dragTo(container, last, 50, 20)
        const classOf = (id: string) => q(container, id)?.getAttribute('class') ?? ''
        expect(q(container, `form-field-${builtinKeys[0]}-drop-before`)).toBeTruthy()
        expect(classOf(`form-field-${builtinKeys[0]}-box`)).toContain('bg-primary/10')
        expect(classOf(`form-field-${last}`)).toContain('opacity-50')
        await act(async () => pointer('pointerup', window, 50, 20))
        expect(draftKeys()).toEqual([last, ...builtinKeys.slice(0, -1)])
        expect(q(container, `form-field-${builtinKeys[0]}-drop-before`)).toBeNull()
        expect(classOf(`form-field-${last}`)).not.toContain('opacity-50')
    })

    it('re-measures on drag start, so a second drag lands where the cells are now', async () => {
        const { container } = render(<Harness />)
        layOutCells(container)
        const last = builtinKeys.at(-1) as string
        await dragTo(container, last, 50, 20)
        await act(async () => pointer('pointerup', window, 50, 20))
        const afterFirst = [last, ...builtinKeys.slice(0, -1)]
        expect(draftKeys()).toEqual(afterFirst)
        // No layout event: the stale rects still put builtinKeys[0] at the top.
        moveCellsSilently(container, afterFirst)
        const moved = afterFirst.at(-1) as string
        await dragTo(container, moved, 50, 20)
        expect(q(container, `form-field-${last}-drop-before`)).toBeTruthy()
        await act(async () => pointer('pointerup', window, 50, 20))
        expect(draftKeys()).toEqual([moved, ...afterFirst.slice(0, -1)])
    })

    it('leaves the draft alone when a drag is cancelled', async () => {
        const { container } = render(<Harness />)
        layOutCells(container)
        await dragTo(container, builtinKeys.at(-1) as string, 50, 20)
        expect(drag?.draggingKey).toBe(builtinKeys.at(-1))
        await act(async () => pointer('pointercancel', window, 50, 20))
        expect(drag?.draggingKey).toBeNull()
        expect(q(container, `form-field-${builtinKeys[0]}-drop-before`)).toBeNull()
        expect(draftKeys()).toEqual(builtinKeys)
        expect(editor?.isDirty).toBe(false)
    })

    it('does not touch the draft when a cell is dropped where it already is', async () => {
        const { container } = render(<Harness />)
        layOutCells(container)
        // The second cell dropped on the right half of the first: its own slot.
        await dragTo(container, builtinKeys[1], 350, 20)
        await act(async () => pointer('pointerup', window, 350, 20))
        expect(draftKeys()).toEqual(builtinKeys)
    })

    it('keeps rendering the last valid canvas while a draft is invalid', async () => {
        const { baseElement, container } = render(<Harness />)
        await addField(baseElement, 'select', 'Severity')
        const index = (editor?.form.getValues('fields').length ?? 0) - 1
        act(() => editor?.form.setValue(`fields.${index}.options`, []))
        expect(q(container, 'form-canvas')).toBeTruthy()
        expect(q(container, 'form-field-severity')).toBeTruthy()
    })
})
