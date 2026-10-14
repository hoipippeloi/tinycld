// tinycld/core/lib/forms/__tests__/use-form-admin.test.tsx
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultDefinitionFor } from '../host'
import { mapDefinitionErrors, slugFor, useFormAdmin } from '../use-form-admin'
import { widgetHost } from './fixtures'

const inserted: unknown[] = []
const updated: { id: string; patch: Record<string, unknown> }[] = []
const deleted: string[] = []
const tx = () => ({ when: () => Promise.resolve() })
vi.mock('@tinycld/core/lib/pocketbase', () => ({
    useStore: () => [
        {
            insert: (row: unknown) => {
                inserted.push(row)
                return tx()
            },
            update: (id: string, fn: (d: Record<string, unknown>) => void) => {
                const d: Record<string, unknown> = {}
                fn(d)
                updated.push({ id, patch: d })
                return tx()
            },
            delete: (id: string) => {
                deleted.push(id)
                return tx()
            },
        },
    ],
}))
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
vi.mock('../use-forms-of-host', () => ({
    useFormsOfHost: () => ({ forms: [plain, bug], defaultForm: plain, isReady: true }),
}))
vi.mock('@tinycld/core/lib/forms/use-form-hosts', () => ({
    useFormHost: () => ({
        ...widgetHost,
        pkgSlug: 'gizmos',
        ui: async () => ({ components: {}, mappers: {} }),
    }),
}))

describe('slugFor', () => {
    it('derives a unique slug', () => {
        expect(slugFor('Bug Report', new Set(['bug_report']))).toBe('bug_report_2')
    })
})

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useFormAdmin', () => {
    it('creates a form from the host default with the next order and a unique slug', async () => {
        const { result } = renderHook(() => useFormAdmin('gizmos:widget'), { wrapper })
        await act(async () => {
            await result.current.create.mutateAsync('Bug')
        })
        const row = inserted.at(-1) as Record<string, unknown>
        expect(row).toMatchObject({
            host: 'gizmos:widget',
            name: 'Bug',
            slug: 'bug_2',
            is_default: false,
            archived: false,
            order: 2,
        })
        expect(row.definition).toEqual(defaultDefinitionFor(widgetHost))
    })
    it('duplicates with " copy" and the source definition', async () => {
        const { result } = renderHook(() => useFormAdmin('gizmos:widget'), { wrapper })
        await act(async () => {
            await result.current.duplicate.mutateAsync('f2')
        })
        expect(inserted.at(-1)).toMatchObject({
            name: 'Bug copy',
            slug: 'bug_copy',
            is_default: false,
            definition: bug.definition,
        })
    })
    it('renames, sets default, archives, reorders, removes and saves through update/delete', async () => {
        const { result } = renderHook(() => useFormAdmin('gizmos:widget'), { wrapper })
        await act(async () => {
            await result.current.rename.mutateAsync({ id: 'f2', name: 'Defect' })
            await result.current.setDefault.mutateAsync('f2')
            await result.current.archive.mutateAsync({ id: 'f2', archived: true })
            await result.current.reorder.mutateAsync(['f2', 'f1'])
            await result.current.saveDefinition.mutateAsync({
                id: 'f2',
                definition: bug.definition,
            })
            await result.current.remove.mutateAsync('f2')
        })
        expect(updated.map(u => [u.id, u.patch])).toEqual([
            ['f2', { name: 'Defect' }],
            ['f2', { is_default: true }],
            ['f2', { archived: true }],
            ['f2', { order: 0 }],
            ['f1', { order: 1 }],
            ['f2', { definition: bug.definition }],
        ])
        expect(deleted).toEqual(['f2'])
    })
})

describe('mapDefinitionErrors', () => {
    it('strips the definition prefix and keeps the path', () => {
        const error = {
            response: {
                data: {
                    'definition.fields.3.key': {
                        code: 'x',
                        message: 'duplicate field key severity',
                    },
                    host: { message: 'bad host' },
                },
            },
        }
        expect(mapDefinitionErrors(error)).toEqual({
            'fields.3.key': 'duplicate field key severity',
            host: 'bad host',
        })
    })
})
