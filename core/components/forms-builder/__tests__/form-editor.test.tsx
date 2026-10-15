// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render as renderBare, within } from '@testing-library/react'
import { log } from '@tinycld/core/lib/logger'
import { router } from 'expo-router'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { FormEditor } from '../FormEditor'

// Menus and dialogs render through the overlay host the app mounts once.
// The canvas loads the host's UI through React Query.
const queryClient = new QueryClient()
const Providers = ({ children }: { children: ReactElement }) => (
    <QueryClientProvider client={queryClient}>
        <OverlayProvider>{children}</OverlayProvider>
    </QueryClientProvider>
)
const render = (ui: ReactElement) => renderBare(<Providers>{ui}</Providers>)

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
const save = vi.fn(async () => {})
const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const admin = {
    host,
    forms: [plain],
    defaultForm: plain,
    isReady: true,
    saveDefinition: { mutateAsync: save, isPending: false },
}
vi.mock('../../../lib/forms/use-form-admin', async importOriginal => ({
    ...(await importOriginal<object>()),
    useFormAdmin: () => admin,
}))
// The live row: a test swaps it to act as a change made elsewhere, or drops it.
const live = vi.hoisted(() => ({ row: undefined as unknown, isMissing: false }))
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: live.isMissing ? undefined : (live.row ?? plain), isReady: true }),
    useFormsOfHost: () => ({ forms: [plain], defaultForm: plain, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => host }))
// React Navigation's guard: `back` stands in for a removal it holds back.
const guard = vi.hoisted(() => ({
    isPreventing: false,
    onPrevent: null as null | ((e: { data: { action: { type: string } } }) => void),
    dispatch: vi.fn(),
}))
vi.mock('expo-router/react-navigation', () => ({
    usePreventRemove: (
        isPreventing: boolean,
        onPrevent: (e: { data: { action: { type: string } } }) => void
    ) => {
        guard.isPreventing = isPreventing
        guard.onPrevent = onPrevent
    },
}))
vi.mock('expo-router', async importOriginal => ({
    ...(await importOriginal<object>()),
    useNavigation: () => ({ dispatch: guard.dispatch }),
}))
const GO_BACK = { type: 'GO_BACK' }
/** What React Navigation does with a removal while the guard is on. */
function leave() {
    if (guard.isPreventing) guard.onPrevent?.({ data: { action: GO_BACK } })
}
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'u1', name: 'U' }, isLoggedIn: true }),
}))
vi.mock('@tinycld/core/components/workspace/useBreakpoint', () => ({
    useBreakpoint: () => 'desktop',
}))
const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null

beforeEach(() => {
    save.mockClear()
    guard.dispatch.mockClear()
    live.row = undefined
    live.isMissing = false
    vi.mocked(router.back).mockReset()
    vi.mocked(router.back).mockImplementation(leave)
})

/** Selects Due and renames it, which makes the editor dirty. */
function editDue(container: HTMLElement, label = 'Deadline') {
    fireEvent.click(q(container, 'form-field-due') as HTMLElement)
    fireEvent.input(q(container, 'fields.2.label') as HTMLElement, { target: { value: label } })
}

describe('FormEditor', () => {
    it('opens the properties panel on cell select and saves when dirty', async () => {
        const { container } = render(<FormEditor formId="f1" />)
        expect(q(container, 'form-panel')).toBeNull()
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        expect(q(container, 'form-panel')).toBeTruthy()
        fireEvent.input(q(container, 'fields.2.label') as HTMLElement, {
            target: { value: 'Deadline' },
        })
        fireEvent.click(q(container, 'form-save') as HTMLElement)
        await act(async () => {})
        expect(save).toHaveBeenCalledWith({
            id: 'f1',
            definition: expect.objectContaining({
                fields: expect.arrayContaining([
                    expect.objectContaining({ key: 'due', label: 'Deadline' }),
                ]),
            }),
        })
    })
    it('shows a server error on the field it names', async () => {
        save.mockRejectedValueOnce({
            response: { data: { 'definition.fields.2.label': { message: 'too long' } } },
        })
        const { container } = render(<FormEditor formId="f1" />)
        editDue(container, 'x')
        fireEvent.click(q(container, 'form-save') as HTMLElement)
        await act(async () => {})
        const panel = q(container, 'form-panel') as HTMLElement
        expect(within(panel).getByText('too long')).toBeTruthy()
    })
    it('says so when a save fails for a reason no field explains', async () => {
        const error = new Error('network down')
        save.mockRejectedValueOnce(error)
        const logError = vi.spyOn(log, 'error').mockImplementation(() => {})
        const { container, getByText } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        fireEvent.input(q(container, 'fields.2.label') as HTMLElement, { target: { value: 'x' } })
        fireEvent.click(q(container, 'form-save') as HTMLElement)
        await act(async () => {})
        expect(getByText('The form could not be saved. Try again.')).toBeTruthy()
        expect(logError).toHaveBeenCalledWith('forms.editor', error, { formId: 'f1' })
        logError.mockRestore()
    })
    it('closes the panel from its close button', () => {
        const { container } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        fireEvent.click(q(container, 'form-panel-close') as HTMLElement)
        expect(q(container, 'form-panel')).toBeNull()
    })
    it('hides the panel on the Rules tab', () => {
        const { container } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        fireEvent.click(q(container, 'form-tab-rules') as HTMLElement)
        expect(q(container, 'form-panel')).toBeNull()
        expect(q(container, 'form-canvas')).toBeNull()
    })
    it('goes back at once when nothing changed', () => {
        const { container, queryByText } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-back') as HTMLElement)
        expect(router.back).toHaveBeenCalled()
        expect(queryByText('Discard changes?')).toBeNull()
        expect(guard.isPreventing).toBe(false)
    })
    it('asks before discarding unsaved changes, then completes the held navigation', () => {
        const { container, getByText } = render(<FormEditor formId="f1" />)
        editDue(container)
        fireEvent.click(q(container, 'form-back') as HTMLElement)
        expect(getByText('Discard changes?')).toBeTruthy()
        expect(guard.dispatch).not.toHaveBeenCalled()
        fireEvent.click(getByText('Discard'))
        expect(guard.dispatch).toHaveBeenCalledWith(GO_BACK)
    })
    it('asks on hardware back or a swipe too, and stays when cancelled', () => {
        const { container, getByText, queryByText } = render(<FormEditor formId="f1" />)
        editDue(container)
        expect(guard.isPreventing).toBe(true)
        act(() => leave())
        expect(getByText('Discard changes?')).toBeTruthy()
        fireEvent.click(getByText('Cancel'))
        expect(queryByText('Discard changes?')).toBeNull()
        expect(guard.dispatch).not.toHaveBeenCalled()
    })
    it('asks the browser to confirm a reload or a closed tab only while dirty', () => {
        const { container } = render(<FormEditor formId="f1" />)
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true })
            window.dispatchEvent(event)
            return event.defaultPrevented
        }
        expect(unload()).toBe(false)
        editDue(container)
        expect(unload()).toBe(true)
    })
    it('says so when the form or its package is missing, with a way back', () => {
        live.isMissing = true
        const { container, getByText } = render(<FormEditor formId="f1" />)
        expect(getByText(/does not exist or its package is not installed/)).toBeTruthy()
        expect(q(container, 'form-editor')).toBeNull()
        fireEvent.click(q(container, 'form-back') as HTMLElement)
        expect(router.back).toHaveBeenCalled()
    })
    it('keeps the draft when the form changes elsewhere, and offers to reload it', () => {
        const { container, getByText, rerender } = render(<FormEditor formId="f1" />)
        editDue(container)
        const fields = plain.definition.fields.map(f =>
            f.key === 'notes' ? { ...f, label: 'Remarks' } : f
        )
        live.row = { ...plain, definition: { ...plain.definition, fields } }
        rerender(
            <Providers>
                <FormEditor formId="f1" />
            </Providers>
        )
        expect(q(container, 'form-changed-elsewhere')).toBeTruthy()
        expect((q(container, 'fields.2.label') as HTMLInputElement).value).toBe('Deadline')
        expect(getByText(/changed elsewhere/)).toBeTruthy()
        fireEvent.click(q(container, 'form-reload') as HTMLElement)
        expect(q(container, 'form-changed-elsewhere')).toBeNull()
        expect((q(container, 'fields.2.label') as HTMLInputElement).value).toBe('Due')
        expect(q(container, 'form-field-notes')?.textContent).toContain('Remarks')
    })
    it('names where each error is in the summary, not its path', async () => {
        save.mockRejectedValueOnce({
            response: {
                data: {
                    'definition.fields.2.label': { message: 'too long' },
                    'definition.rules.0.when.1.value': { message: 'bad value' },
                },
            },
        })
        const { container } = render(<FormEditor formId="f1" />)
        editDue(container, 'x')
        fireEvent.click(q(container, 'form-save') as HTMLElement)
        await act(async () => {})
        const summary = q(container, 'form-errors')?.textContent ?? ''
        expect(summary).toContain("Field 'x', label: too long")
        expect(summary).toContain('Rule 1, condition 2: bad value')
        expect(summary).not.toContain('fields.2')
    })
})
