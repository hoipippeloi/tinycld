// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { hostDefSchema } from '../../../lib/forms/host'

const h = vi.hoisted(() => ({
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
    return { collectionByName: (name: string) => stores[name] }
})

import { FileField } from '../fields/FileField'

afterEach(cleanup)

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

function renderField(recordId: string) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <FileField
                host={hostWithFiles}
                fieldKey="shot"
                recordId={recordId}
                value={[]}
                onChange={() => {}}
                multiple
                accept={[]}
            />
        </QueryClientProvider>
    )
}

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
})
