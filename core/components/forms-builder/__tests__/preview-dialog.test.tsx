// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render as renderBare, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField } from '../../../lib/forms/builder'
import { definitionSchema } from '../../../lib/forms/definition'
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
const def = definitionSchema.parse({
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
})
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
    host: {
        ...widgetHost,
        pkgSlug: 'gizmos',
        pkgName: 'Gizmos',
        ui: async () => ({ components: {} }),
    },
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

function Harness({ row = plain }: { row?: typeof plain }) {
    const editor = useEditorForm(row, admin.host)
    return <PreviewDialog editor={editor} context={ctx} isOpen onClose={() => {}} />
}

const onePage = {
    ...plain,
    definition: definitionSchema.parse({
        ...def,
        pages: [def.pages[0]],
        fields: def.fields.filter(f => f.page === 'main'),
        rules: [],
    }),
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

    // A one-page form is still previewed as a wizard: its Done button is the
    // only way to see what a required field says when it is left empty.
    it('previews a one-page form with a Done button that validates', async () => {
        const { container, getByText, queryAllByText } = render(<Harness row={onePage} />)
        await waitFor(() => expect(q(container, 'form-wizard-next')).toBeTruthy())
        expect(q(container, 'form-wizard-steps')).toBeNull()
        expect(getByText('Done')).toBeTruthy()
        fireEvent.click(q(container, 'form-wizard-next') as HTMLElement)
        await waitFor(() => expect(queryAllByText('Name is required').length).toBeGreaterThan(0))
        // The cell shows the message once; the input only colours its border. The
        // summary above the form repeats the sentence, without a "name:" prefix.
        const cell = q(container, 'form-field-name')
        expect(cell?.querySelectorAll('[accessibilityRole="alert"]').length).toBe(1)
        expect(getByText('Please fix the following errors:')).toBeTruthy()
        expect(queryAllByText(/^name:/).length).toBe(0)
        expect(queryAllByText('Name is required').length).toBe(2)
    })

    it('Phone shows the form in a 390px frame and Desktop at full width', async () => {
        const { container } = render(<Harness />)
        await waitFor(() => expect(q(container, 'form-wizard-steps')).toBeTruthy())
        expect(q(container, 'form-preview-viewport-phone')).toBeNull()
        fireEvent.click(q(container, 'form-preview-phone') as HTMLElement)
        await waitFor(() =>
            expect(q(container, 'form-preview-viewport-phone')?.style.width).toBe('390px')
        )
        expect(q(container, 'form-preview-phone')?.getAttribute('aria-checked')).toBe('true')
        expect(q(container, 'form-preview-phone')?.getAttribute('aria-selected')).toBeNull()
        fireEvent.click(q(container, 'form-preview-desktop') as HTMLElement)
        await waitFor(() => expect(q(container, 'form-preview-viewport-phone')).toBeNull())
    })
})
