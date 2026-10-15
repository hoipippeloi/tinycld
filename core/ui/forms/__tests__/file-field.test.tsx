// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { hostDefSchema } from '../../../lib/forms/host'

const h = vi.hoisted(() => ({
    collectionByName: vi.fn(),
    widgets: undefined as { insert: (row: { id: string }) => unknown } | undefined,
    upload: vi.fn(async (_args: { fields: Record<string, unknown> }) => {}),
}))

vi.mock('@tinycld/core/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('@tinycld/core/file-viewer/upload-file', () => ({ uploadRecordWithFile: h.upload }))
vi.mock('@tinycld/core/file-viewer/use-pick-files', () => ({
    usePickFiles: () => ({
        pickFiles: async () => [{ name: 'shot.png', size: 12, uri: 'file:///shot.png' }],
    }),
}))
vi.mock('@tinycld/core/lib/pocketbase', async () => {
    const { BasicIndex, createCollection, localOnlyCollectionOptions } = await import(
        '@tanstack/db'
    )
    const local = (id: string, initialData: { id: string }[]) =>
        Object.assign(
            createCollection({
                ...localOnlyCollectionOptions({
                    id,
                    getKey: (r: { id: string }): string | number => r.id,
                    initialData,
                }),
                autoIndex: 'eager',
                defaultIndexType: BasicIndex,
            }),
            { reload: async () => {} }
        )
    const stores: Record<string, ReturnType<typeof local>> = {
        gizmos_files: local('file-field-files', []),
        gizmos_widgets: local('file-field-widgets', [{ id: 'r1', owner: 'p9' } as { id: string }]),
    }
    h.widgets = stores.gizmos_widgets
    h.collectionByName.mockImplementation((name: string) => stores[name])
    return { collectionByName: h.collectionByName }
})

import { FileField } from '../fields/FileField'

afterEach(() => {
    cleanup()
    h.upload.mockClear()
    h.collectionByName.mockClear()
})

const files = {
    collection: 'gizmos_files',
    recordColumn: 'widget',
    fieldColumn: 'field',
    sizeColumn: 'size',
    uploaderColumn: 'uploaded_by',
    copyColumns: { project: 'owner' },
}
const hostWithFiles = {
    ...hostDefSchema.parse({ ...widgetHost, files }),
    pkgSlug: 'gizmos',
    ui: async () => ({ components: {}, mappers: {} }),
}

function seedWidget(row: { id: string } & Record<string, unknown>) {
    h.widgets?.insert(row)
}

function attachmentRows() {
    return h.upload.mock.calls.map(call => call[0].fields)
}

// The Button root reports isDisabled as data-disabled; the RN stub only stringifies aria-* booleans.
function addFilesButton() {
    return screen.getByText('Add files').closest('[role="button"]') as HTMLElement
}

function renderField(
    recordId: string,
    hostOverrides: { copyColumns?: Record<string, string> } = {}
) {
    const host = {
        ...hostWithFiles,
        ...hostDefSchema.parse({ ...widgetHost, files: { ...files, ...hostOverrides } }),
    }
    const view = render(
        <QueryClientProvider client={new QueryClient()}>
            <FileField
                host={host}
                fieldKey="shot"
                recordId={recordId}
                value={[]}
                onChange={() => {}}
                multiple
                accept={[]}
            />
        </QueryClientProvider>
    )
    const upload = async (_file: unknown) => {
        await waitFor(() => expect(addFilesButton().getAttribute('data-disabled')).not.toBe('true'))
        fireEvent.click(screen.getByText('Add files'))
        await waitFor(() => expect(h.upload).toHaveBeenCalled())
    }
    return { ...view, upload, addFilesButton }
}

const pngFile = () => ({ name: 'shot.png', size: 12, uri: 'file:///shot.png' })

describe('FileField', () => {
    it('copies the host record columns the host asks for onto the upload', async () => {
        renderField('r1')
        await waitFor(() => expect(screen.getByText('Add files')).toBeTruthy())
        fireEvent.click(screen.getByText('Add files'))
        await waitFor(() => expect(h.upload).toHaveBeenCalled())
        expect(h.upload.mock.calls[0][0].fields).toMatchObject({
            widget: 'r1',
            field: 'shot',
            project: 'p9',
        })
    })

    it('copies only scalar source columns', async () => {
        seedWidget({ id: 'r2', owner: 'p9', count: 5, tags: ['a', 'b'] })
        const { upload } = renderField('r2', {
            copyColumns: { project: 'owner', n: 'count', tags: 'tags' },
        })
        await upload(pngFile())
        const row = attachmentRows()[0]
        expect(row.project).toBe('p9')
        expect(row.n).toBe('5')
        expect(row).not.toHaveProperty('tags')
    })

    it('does not query the host collection when nothing is copied', () => {
        renderField('r1', { copyColumns: {} })
        expect(h.collectionByName).not.toHaveBeenCalledWith('gizmos_widgets')
    })

    it('keeps Add files disabled until the host row has loaded', async () => {
        const { addFilesButton } = renderField('missing', { copyColumns: { project: 'owner' } })
        expect(addFilesButton().getAttribute('data-disabled')).toBe('true')
        seedWidget({ id: 'missing', owner: 'p1' })
        await waitFor(() => expect(addFilesButton().getAttribute('data-disabled')).not.toBe('true'))
    })
})
