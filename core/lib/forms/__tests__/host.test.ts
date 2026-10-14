import { describe, expect, it } from 'vitest'
import { validateDefinitionForHost } from '../definition'
import { defaultDefinitionFor, hostDefSchema, resolveFragment } from '../host'
import { widgetHost } from './fixtures'

describe('hostDefSchema', () => {
    it('accepts the widget host', () => {
        expect(hostDefSchema.safeParse(widgetHost).success).toBe(true)
    })
    it('rejects a key without a colon', () => {
        expect(hostDefSchema.safeParse({ ...widgetHost, key: 'widget' }).success).toBe(false)
    })
    it('rejects a rows builtin without a mapper', () => {
        const builtin = widgetHost.builtin.map(b =>
            b.key === 'tasks' ? { ...b, mapper: undefined } : b
        )
        expect(hostDefSchema.safeParse({ ...widgetHost, builtin }).success).toBe(false)
    })
    it('rejects a section with storage other than none', () => {
        const builtin = widgetHost.builtin.map(b =>
            b.key === 'comments' ? { ...b, storage: 'column' } : b
        )
        expect(hostDefSchema.safeParse({ ...widgetHost, builtin }).success).toBe(false)
    })
})

describe('defaultDefinitionFor', () => {
    it('places every builtin on one page in declared order', () => {
        const def = defaultDefinitionFor(widgetHost)
        expect(def.pages).toEqual([{ key: 'main', title: 'Widget' }])
        expect(def.fields.map(f => f.key)).toEqual([
            'name',
            'notes',
            'due',
            'owner',
            'tasks',
            'comments',
        ])
        expect(def.fields.every(f => f.kind === 'builtin' && f.page === 'main')).toBe(true)
        expect(def.fields[0]).toMatchObject({
            required: true,
            label: 'Name',
            width: 'full',
            hidden: false,
        })
    })
})

describe('validateDefinitionForHost', () => {
    const ok = defaultDefinitionFor(widgetHost)
    it('accepts the default definition', () => {
        expect(validateDefinitionForHost(ok, widgetHost)).toEqual([])
    })
    it('reports a missing builtin', () => {
        const def = { ...ok, fields: ok.fields.filter(f => f.key !== 'due') }
        expect(validateDefinitionForHost(def, widgetHost)).toEqual([
            { path: ['fields'], message: 'missing built-in field due' },
        ])
    })
    it('reports a custom key that collides with a host column', () => {
        const def = {
            ...ok,
            fields: [
                ...ok.fields,
                {
                    key: 'position',
                    kind: 'text' as const,
                    page: 'main',
                    label: 'P',
                    width: 'full' as const,
                    required: false,
                    hidden: false,
                },
            ],
        }
        expect(validateDefinitionForHost(def, widgetHost)[0]?.message).toBe(
            'position is a column of the record and cannot be a custom field'
        )
    })
    it('reports a hidden required builtin', () => {
        const def = {
            ...ok,
            fields: ok.fields.map(f => (f.key === 'name' ? { ...f, hidden: true } : f)),
        }
        expect(validateDefinitionForHost(def, widgetHost)[0]?.message).toBe(
            'name is required by the record and cannot be hidden'
        )
    })
    it('reports an operator the builtin kind does not support', () => {
        const def = {
            ...ok,
            rules: [
                {
                    key: 'r',
                    match: 'all' as const,
                    when: [{ field: 'due', op: 'contains' as const, value: 'x' }],
                    actions: [{ action: 'hide' as const, field: 'owner' }],
                },
            ],
        }
        expect(validateDefinitionForHost(def, widgetHost)[0]?.message).toBe(
            'contains is not valid for a date field'
        )
    })
    it('reports a builtin ref whose key is not a host builtin', () => {
        const def = {
            ...ok,
            fields: [
                ...ok.fields,
                {
                    key: 'ghost',
                    kind: 'builtin' as const,
                    page: 'main',
                    label: 'G',
                    width: 'full' as const,
                    required: false,
                    hidden: false,
                },
            ],
        }
        expect(validateDefinitionForHost(def, widgetHost)[0]?.message).toBe(
            'ghost is not a built-in field of Widget'
        )
    })
})

describe('resolveFragment', () => {
    it('substitutes record, format and key', () => {
        expect(resolveFragment('widget:{record}:{format}:{key}', 'abc', 'notes', 'md')).toBe(
            'widget:abc:md:notes'
        )
    })
})
