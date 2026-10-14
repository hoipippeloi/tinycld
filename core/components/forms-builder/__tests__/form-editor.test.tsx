// @vitest-environment happy-dom
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
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: plain, isReady: true }),
    useFormsOfHost: () => ({ forms: [plain], defaultForm: plain, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => host }))
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'u1', name: 'U' }, isLoggedIn: true }),
}))
vi.mock('@tinycld/core/components/workspace/useBreakpoint', () => ({
    useBreakpoint: () => 'desktop',
}))
const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null

beforeEach(() => {
    save.mockClear()
    vi.mocked(router.back).mockClear()
})

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
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        fireEvent.input(q(container, 'fields.2.label') as HTMLElement, { target: { value: 'x' } })
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
        const { container } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-back') as HTMLElement)
        expect(router.back).toHaveBeenCalled()
    })
    it('asks before discarding unsaved changes', () => {
        const { container, getByText } = render(<FormEditor formId="f1" />)
        fireEvent.click(q(container, 'form-field-due') as HTMLElement)
        fireEvent.input(q(container, 'fields.2.label') as HTMLElement, {
            target: { value: 'Deadline' },
        })
        fireEvent.click(q(container, 'form-back') as HTMLElement)
        expect(router.back).not.toHaveBeenCalled()
        expect(getByText('Discard changes?')).toBeTruthy()
        fireEvent.click(getByText('Discard'))
        expect(router.back).toHaveBeenCalled()
    })
})
