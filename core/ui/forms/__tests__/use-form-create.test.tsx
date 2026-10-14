// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { useFormCreate } from '../use-form-create'

const host = { ...widgetHost, pkgSlug: 'gizmos', ui: async () => ({ components: {}, mappers: {} }) }
const plain = {
    id: 'f1',
    host: host.key,
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: defaultDefinitionFor(widgetHost),
}
const bug = {
    id: 'f2',
    host: host.key,
    name: 'Bug',
    slug: 'bug',
    is_default: false,
    archived: false,
    order: 1,
    definition: definitionSchema.parse({
        ...defaultDefinitionFor(widgetHost),
        fields: [
            ...defaultDefinitionFor(widgetHost).fields,
            {
                key: 'severity',
                kind: 'select',
                page: 'main',
                label: 'Severity',
                options: [{ value: 'low', label: 'Low' }],
            },
        ],
        defaults: { severity: 'low', due: { addDays: [{ today: [] }, 21] } },
    }),
}

vi.mock('../../../lib/forms/use-forms-of-host', () => ({
    useFormsOfHost: () => ({ forms: [plain, bug], defaultForm: plain, isReady: true }),
}))

const ctx = { today: '2026-01-10', userId: 'me' }

describe('useFormCreate', () => {
    it('seeds defaults for the chosen form and splits on submit', async () => {
        const { result } = renderHook(() => useFormCreate(host, 'f2', ctx))
        expect(result.current.form.getValues('severity')).toBe('low')
        expect(result.current.form.getValues('due')).toBe('2026-01-31')
        act(() => result.current.form.setValue('name', 'W'))
        const split = await result.current.submit()
        expect(split).toEqual({
            columns: { name: 'W', due: '2026-01-31' },
            fields: { severity: 'low' },
            rows: {},
        })
    })
    it('returns null and sets errors when required fields are empty', async () => {
        const { result } = renderHook(() => useFormCreate(host, 'f2', ctx))
        const split = await result.current.submit()
        expect(split).toBeNull()
        expect(result.current.form.getFieldState('name').error).toBeTruthy()
    })
    it('switchForm keeps shared keys and re-applies defaults for the rest', () => {
        const { result } = renderHook(() => useFormCreate(host, 'f1', ctx))
        act(() => result.current.form.setValue('name', 'Keep me'))
        act(() => result.current.switchForm('f2'))
        expect(result.current.formId).toBe('f2')
        expect(result.current.form.getValues('name')).toBe('Keep me')
        expect(result.current.form.getValues('severity')).toBe('low')
    })
})
