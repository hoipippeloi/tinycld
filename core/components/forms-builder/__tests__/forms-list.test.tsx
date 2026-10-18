// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render as renderBare, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { FormsHostList } from '../FormsHostList'
import { FormsList } from '../FormsList'

// Menu and the dialogs render through the overlay host the app mounts once.
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
const bug = { ...plain, id: 'f2', name: 'Bug', slug: 'bug', is_default: false, order: 1 }
const admin = {
    host: {
        ...widgetHost,
        pkgSlug: 'gizmos',
        pkgName: 'Gizmos',
        ui: async () => ({ components: {} }),
    },
    forms: [plain, bug],
    defaultForm: plain,
    isReady: true,
    create: { mutateAsync: vi.fn(async () => 'f3'), isPending: false },
    duplicate: { mutateAsync: vi.fn(async () => 'f4'), isPending: false },
    rename: { mutateAsync: vi.fn(async () => {}), isPending: false },
    setDefault: { mutateAsync: vi.fn(async () => {}), isPending: false },
    archive: { mutateAsync: vi.fn(async () => {}), isPending: false },
    reorder: { mutateAsync: vi.fn(async () => {}), isPending: false },
    saveDefinition: { mutateAsync: vi.fn(async () => {}), isPending: false },
    remove: { mutateAsync: vi.fn(async () => {}), isPending: false },
}
vi.mock('../../../lib/forms/use-form-admin', () => ({ useFormAdmin: () => admin }))
const hosts = vi.hoisted(() => ({
    list: [] as { key: string; label: string; pkgSlug?: string }[],
}))
vi.mock('@tinycld/core/lib/packages/use-packages', () => ({
    usePackages: () => [{ slug: 'gizmos', name: 'Gizmos' }],
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({
    useFormHosts: () => hosts.list,
    useFormHost: (key: string) => hosts.list.find(h => h.key === key),
}))

const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null

describe('FormsList', () => {
    it('lists forms with the default marked and opens one', () => {
        const onOpen = vi.fn()
        const { container, getByText } = render(
            <FormsList hostKey="gizmos:widget" onOpen={onOpen} />
        )
        expect(getByText('Widget')).toBeTruthy()
        expect(getByText('Bug')).toBeTruthy()
        expect(q(container, 'forms-row-f1')?.textContent).toContain('Default')
        fireEvent.click(q(container, 'forms-open-f2') as HTMLElement)
        expect(onOpen).toHaveBeenCalledWith('f2')
    })
    it('disables delete for the default form only', () => {
        const { container, getByTestId } = render(
            <FormsList hostKey="gizmos:widget" onOpen={() => {}} />
        )
        fireEvent.click(q(container, 'forms-menu-f1') as HTMLElement)
        expect(getByTestId('forms-delete-f1').getAttribute('aria-disabled')).toBe('true')
        fireEvent.click(q(container, 'forms-menu-f2') as HTMLElement)
        expect(getByTestId('forms-delete-f2').getAttribute('aria-disabled')).not.toBe('true')
    })
    it('says why a menu item is disabled in its label', () => {
        const { container, getByTestId } = render(
            <FormsList hostKey="gizmos:widget" onOpen={() => {}} />
        )
        fireEvent.click(q(container, 'forms-menu-f1') as HTMLElement)
        expect(getByTestId('forms-delete-f1').textContent).toContain('Delete… (default form)')
        expect(getByTestId('forms-archive-f1').textContent).toContain('Archive (default form)')
        expect(getByTestId('forms-default-f1').textContent).toContain(
            'Make default (already the default)'
        )
    })
    it('says the server refuses to delete a form in use', () => {
        const { container, getByTestId, getByText } = render(
            <FormsList hostKey="gizmos:widget" onOpen={() => {}} />
        )
        fireEvent.click(q(container, 'forms-menu-f2') as HTMLElement)
        fireEvent.click(getByTestId('forms-delete-f2'))
        expect(
            getByText(
                'Records using this form must change type first; the server refuses to delete a form in use.'
            )
        ).toBeTruthy()
    })
    it('names the host over its forms only when there are several hosts', () => {
        hosts.list = [{ key: 'gizmos:widget', label: 'Widget' }]
        const one = render(<FormsList hostKey="gizmos:widget" onOpen={() => {}} />)
        expect(q(one.container, 'forms-host-heading')).toBeNull()
        cleanup()
        hosts.list = [
            { key: 'gizmos:widget', label: 'Widgets' },
            { key: 'gizmos:gadget', label: 'Gadgets' },
        ]
        const several = render(<FormsList hostKey="gizmos:widget" onOpen={() => {}} />)
        expect(q(several.container, 'forms-host-heading')?.textContent).toBe('Widgets')
        hosts.list = []
    })
    it('creates a form from the New form dialog', async () => {
        const { container, getByText } = render(
            <FormsList hostKey="gizmos:widget" onOpen={() => {}} />
        )
        fireEvent.click(q(container, 'forms-new') as HTMLElement)
        const input = container.querySelector('rn-textinput') as HTMLElement
        await act(async () => {
            fireEvent.input(input, { target: { value: 'Feature' } })
        })
        await act(async () => {
            fireEvent.click(getByText('Create'))
        })
        await waitFor(() => expect(admin.create.mutateAsync).toHaveBeenCalledWith('Feature'))
    })
})

describe('FormsHostList', () => {
    it('lists each host with its package and picks one', () => {
        hosts.list = [
            { key: 'gizmos:widget', label: 'Widgets', pkgSlug: 'gizmos' },
            { key: 'gizmos:gadget', label: 'Gadgets', pkgSlug: 'other' },
        ]
        const onPick = vi.fn()
        const { container } = render(<FormsHostList onPick={onPick} />)
        expect(q(container, 'forms-host-gizmos:widget')?.textContent).toBe('WidgetsGizmos')
        expect(q(container, 'forms-host-gizmos:gadget')?.textContent).toBe('Gadgetsother')
        fireEvent.click(q(container, 'forms-host-gizmos:gadget') as HTMLElement)
        expect(onPick).toHaveBeenCalledWith('gizmos:gadget')
        hosts.list = []
    })
})
