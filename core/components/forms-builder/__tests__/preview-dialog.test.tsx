// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render as renderBare, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { OverlayProvider } from '../../../ui/overlay'
import { PreviewDialog } from '../PreviewDialog'
import { useEditorForm } from '../use-editor-form'

afterEach(cleanup)
const render = (ui: ReactElement) =>
    renderBare(
        <QueryClientProvider client={new QueryClient()}>
            <OverlayProvider>{ui}</OverlayProvider>
        </QueryClientProvider>
    )
const base = defaultDefinitionFor(widgetHost)
const def = {
    ...base,
    pages: [
        { key: 'main', title: 'Widget' },
        { key: 'more', title: 'More' },
    ],
    fields: [
        ...base.fields,
        {
            ...newCustomField('select', 'Severity', 'main', new Set()),
            options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
            ],
        },
        newCustomField('text', 'Steps', 'more', new Set()),
    ],
    rules: [
        {
            key: 'r',
            match: 'all',
            when: [{ field: 'severity', op: 'is', value: 'high' }],
            actions: [{ action: 'require', field: 'steps' }],
        },
    ],
    defaults: { severity: 'low' },
}
const plain = {
    id: 'f1',
    host: 'gizmos:widget',
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: def,
}
const admin = {
    host: { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) },
    forms: [plain],
    defaultForm: plain,
    isReady: true,
    saveDefinition: { mutateAsync: vi.fn(), isPending: false },
}
vi.mock('../../../lib/forms/use-form-admin', async importOriginal => ({
    ...(await importOriginal<object>()),
    useFormAdmin: () => admin,
}))
vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormRow: () => ({ row: plain, isReady: true }),
    useFormsOfHost: () => ({ forms: [plain], defaultForm: plain, isReady: true }),
}))
vi.mock('../../../lib/forms/use-form-hosts', () => ({ useFormHost: () => admin.host }))
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'u1', name: 'U' }, isLoggedIn: true }),
}))
vi.mock('@tinycld/core/components/workspace/useBreakpoint', () => ({
    useBreakpoint: () => 'desktop',
}))
const q = (c: HTMLElement, id: string) => c.querySelector(`[testID="${id}"]`) as HTMLElement | null
const ctx = { today: '2026-01-01', userId: 'u1' }

function Harness() {
    const editor = useEditorForm('f1')
    return <PreviewDialog editor={editor} context={ctx} isOpen onClose={() => {}} />
}

describe('PreviewDialog', () => {
    it('renders the draft as a wizard with defaults applied and rules live', async () => {
        const { container } = render(<Harness />)
        await waitFor(() => expect(q(container, 'form-wizard-steps')).toBeTruthy())
        expect(q(container, 'form-field-severity')).toBeTruthy()
        expect(q(container, 'form-field-steps')).toBeNull()
        fireEvent.input(q(container, 'form-input-name') as HTMLElement, { target: { value: 'n' } })
        fireEvent.click(q(container, 'form-wizard-next') as HTMLElement)
        await waitFor(() => expect(q(container, 'form-field-steps')).toBeTruthy())
    })
})
