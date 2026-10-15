// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { type Resolver, type UseFormReturn, useForm } from 'react-hook-form'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema, type FormDefinition } from '../../../lib/forms/definition'
import { defaultDefinitionFor, hostDefSchema } from '../../../lib/forms/host'
import type { BuiltinFieldProps, FormHostUi } from '../../../lib/forms/host-ui'
import { type FormLayoutKind, FormRenderer, type SectionsScroll } from '../FormRenderer'

// The test stub's ScrollView is a plain element; the pinning under test is
// react-native-web's own (`stickyHeaderIndices` wraps each sticky child in a
// `position: sticky` View), so the real component stands in for it here.
vi.mock('react-native', async importOriginal => {
    const stub = await importOriginal<typeof import('react-native')>()
    const web = await import('react-native-web')
    return { ...stub, ScrollView: web.ScrollView }
})

afterEach(cleanup)

const host = {
    ...hostDefSchema.parse(widgetHost),
    pkgSlug: 'gizmos',
    ui: async () => ui,
}

function NotesField({ fieldKey }: BuiltinFieldProps) {
    return <Text testID={`body-${fieldKey}`}>Notes body</Text>
}

function PinnedHeader({ fieldKey }: BuiltinFieldProps) {
    return <Text testID={`header-${fieldKey}`}>pinned header</Text>
}

const ui: FormHostUi = {
    components: { NotesField, CommentsSection: NotesField },
    pinned: { NotesField: PinnedHeader },
    mappers: {},
}

const bothPinned: FormHostUi = {
    ...ui,
    pinned: { NotesField: PinnedHeader, CommentsSection: PinnedHeader },
}

const builtins = defaultDefinitionFor(host)

const twoPages = definitionSchema.parse({
    ...builtins,
    pages: [
        { key: 'main', title: 'Main' },
        { key: 'more', title: 'More' },
    ],
    fields: builtins.fields.map(f => (f.key === 'comments' ? { ...f, page: 'more' } : f)),
})

const nameIsHalf = definitionSchema.parse({
    ...builtins,
    fields: builtins.fields.map(f => (f.key === 'name' ? { ...f, width: 'half' } : f)),
})

const ctx = { today: '2026-01-01', userId: 'u' }

type Form = UseFormReturn<Record<string, unknown>>

// Every submit fails on `name`, so the errors row has something to show.
const failingResolver: Resolver<Record<string, unknown>> = async () => ({
    values: {},
    errors: { name: { type: 'required', message: 'Name is required' } },
})

interface HarnessProps {
    layout?: FormLayoutKind
    recordId?: string
    readOnly?: boolean
    scroll?: SectionsScroll
    hostUi?: FormHostUi
    definition?: FormDefinition
    formRef?: { current: Form | null }
}

function Harness({
    layout = 'sections',
    recordId = 'r1',
    readOnly,
    scroll,
    hostUi = ui,
    definition = builtins,
    formRef,
}: HarnessProps) {
    const form = useForm<Record<string, unknown>>({ defaultValues: {}, resolver: failingResolver })
    if (formRef) formRef.current = form
    return (
        <FormRenderer
            host={host}
            ui={hostUi}
            definition={definition}
            layout={layout}
            form={form}
            context={ctx}
            recordId={recordId}
            readOnly={readOnly}
            scroll={scroll}
            testID="form"
        />
    )
}

// The stub renders `testID` as is; react-native-web lowercases it.
const byId = (container: HTMLElement, id: string) =>
    container.querySelector(`[testID="${id}"], [testid="${id}"]`) as HTMLElement | null

const isSticky = (el: Element | null | undefined) =>
    !!el && getComputedStyle(el).position === 'sticky'

function contentContainer(container: HTMLElement) {
    const root = byId(container, 'form')
    // root → ScrollView → its content container
    return root?.firstElementChild?.firstElementChild as HTMLElement
}

describe('a pinned host row', () => {
    it('renders above its field and outside its cell', () => {
        const { container, getByText } = render(<Harness />)
        const pinned = byId(container, 'form-pinned-notes')
        const cell = byId(container, 'form-field-notes')
        expect(pinned).toBeTruthy()
        expect(cell).toBeTruthy()
        expect(getByText('pinned header')).toBeTruthy()
        expect(cell?.contains(pinned as Node)).toBe(false)
        expect(
            (pinned as Node).compareDocumentPosition(cell as Node) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        // The body stays a bare cell of its own.
        expect(cell?.contains(byId(container, 'body-notes'))).toBe(true)
    })

    it('renders in read mode too', () => {
        const { container } = render(<Harness readOnly />)
        expect(byId(container, 'form-pinned-notes')).toBeTruthy()
    })

    it('is a direct, sticky child of the scroll content when the renderer owns the scroll', () => {
        const { container } = render(<Harness scroll={{ rowClassName: 'px-6' }} />)
        const pinned = byId(container, 'form-pinned-notes')
        const wrapper = pinned?.parentElement
        expect(wrapper?.parentElement).toBe(contentContainer(container))
        expect(isSticky(wrapper)).toBe(true)
        expect(pinned?.getAttribute('class')).toBe('px-6')
    })

    it('pins every pinned field', () => {
        const { container } = render(
            <Harness scroll={{ rowClassName: 'px-6' }} hostUi={bothPinned} />
        )
        expect(isSticky(byId(container, 'form-pinned-notes')?.parentElement)).toBe(true)
        expect(isSticky(byId(container, 'form-pinned-comments')?.parentElement)).toBe(true)
    })

    const stickyRowIds = (container: HTMLElement) =>
        Array.from(contentContainer(container).children)
            .filter(isSticky)
            .map(el => el.firstElementChild?.getAttribute('testid'))

    it('pins the pinned rows only, under a page title', () => {
        const { container, getByText } = render(
            <Harness scroll={{ rowClassName: 'px-6' }} hostUi={bothPinned} definition={twoPages} />
        )
        expect(getByText('More')).toBeTruthy()
        expect(stickyRowIds(container)).toEqual(['form-pinned-notes', 'form-pinned-comments'])
    })

    it('pins the pinned rows only, under the errors row', async () => {
        const formRef: { current: Form | null } = { current: null }
        const { container, getAllByText } = render(
            <Harness scroll={{ rowClassName: 'px-6' }} hostUi={bothPinned} formRef={formRef} />
        )
        await act(async () => {
            await formRef.current?.handleSubmit(() => {})()
        })
        expect(getAllByText('Name is required').length).toBeGreaterThan(0)
        expect(stickyRowIds(container)).toEqual(['form-pinned-notes', 'form-pinned-comments'])
    })

    it('keeps the page testID on the page first row', () => {
        const { container } = render(<Harness definition={twoPages} />)
        expect(byId(container, 'form-page-main')?.textContent).toContain('Main')
        expect(byId(container, 'form-page-more')?.textContent).toContain('More')
    })

    it('is never rendered by the create wizard', () => {
        const { container } = render(<Harness layout="wizard" recordId="" />)
        expect(byId(container, 'form-pinned-notes')).toBeNull()
    })

    it('is never rendered on the design canvas', () => {
        const { container, queryByText } = render(<Harness layout="design" />)
        expect(byId(container, 'form-pinned-notes')).toBeNull()
        expect(queryByText('pinned header')).toBeNull()
    })
})

describe('the sections container width', () => {
    const fireLayout = (node: Element | null | undefined, width: number) =>
        fireEvent(
            node as Element,
            new CustomEvent('rn-layout', { detail: { width, height: 1, x: 0, y: 0 } })
        )
    const nameCellClass = (container: HTMLElement) =>
        byId(container, 'form-field-name')?.getAttribute('class') ?? ''

    it('is measured inside the row padding, not on the root', () => {
        const { container } = render(
            <Harness definition={nameIsHalf} scroll={{ rowClassName: 'px-6' }} />
        )
        const errorsRow = contentContainer(container).firstElementChild
        // The root spans the padding too; measuring there would read too wide.
        fireLayout(byId(container, 'form'), 1000)
        fireLayout(errorsRow?.firstElementChild, 500)
        expect(nameCellClass(container)).toContain('basis-full')
        fireLayout(errorsRow?.firstElementChild, 800)
        expect(nameCellClass(container)).toContain('basis-1/2')
    })
})
