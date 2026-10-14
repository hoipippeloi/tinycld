import { describe, expect, it } from 'vitest'
import { definitionSchema } from '../definition'
import { defaultDefinitionFor } from '../host'
import { evaluate } from '../logic'
import { buildSchema, mergeValues, splitValues } from '../values'
import { widgetHost } from './fixtures'

const def = definitionSchema.parse({
    ...defaultDefinitionFor(widgetHost),
    fields: [
        ...defaultDefinitionFor(widgetHost).fields,
        {
            key: 'severity',
            kind: 'select',
            page: 'main',
            label: 'Severity',
            options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
            ],
        },
        { key: 'count', kind: 'number', page: 'main', label: 'Count', min: 0, max: 10 },
        { key: 'extra', kind: 'checklist', page: 'main', label: 'Extra' },
        { key: 'shot', kind: 'file', page: 'main', label: 'Shot', multiple: true },
    ],
    rules: [
        {
            key: 'r',
            when: [{ field: 'severity', op: 'is', value: 'high' }],
            actions: [{ action: 'require', field: 'count' }],
        },
    ],
})
const ctx = { today: '2026-01-01', userId: 'u' }

describe('buildSchema', () => {
    it('requires a required builtin and a rule-required field', () => {
        const state = evaluate(def, { severity: 'high' }, ctx)
        const r = buildSchema(def, widgetHost, state).safeParse({ severity: 'high' })
        expect(r.success).toBe(false)
        const paths = r.error?.issues.map(i => i.path.join('.'))
        expect(paths).toContain('name')
        expect(paths).toContain('count')
    })
    it('does not require a field hidden by a rule state', () => {
        const state = evaluate(def, { severity: 'low' }, ctx)
        const r = buildSchema(def, widgetHost, state).safeParse({ name: 'n' })
        expect(r.success).toBe(true)
    })
    it('rejects a select value outside the options and a number outside min max', () => {
        const state = evaluate(def, {}, ctx)
        const r = buildSchema(def, widgetHost, state).safeParse({
            name: 'n',
            severity: 'nope',
            count: 11,
        })
        const paths = r.error?.issues.map(i => i.path.join('.'))
        expect(paths).toEqual(expect.arrayContaining(['severity', 'count']))
    })
    it('skips sections, rows builtins and collaborative fields', () => {
        const state = evaluate(def, {}, ctx)
        const shape = buildSchema(def, widgetHost, state)
        expect(shape.safeParse({ name: 'n', comments: 'x', tasks: 'y', notes: 'z' }).success).toBe(
            true
        )
    })
})

describe('splitValues', () => {
    it('routes builtin columns, custom json and rows', () => {
        const out = splitValues(widgetHost, def, {
            name: 'N',
            due: '2026-01-02',
            severity: 'low',
            count: 2,
            tasks: [{ id: 't1', text: 'a', done: false }],
            extra: [{ id: 'e1', text: 'b', done: true }],
            comments: 'ignored',
        })
        expect(out).toEqual({
            columns: { name: 'N', due: '2026-01-02' },
            fields: { severity: 'low', count: 2, extra: [{ id: 'e1', text: 'b', done: true }] },
            rows: { tasks: [{ id: 't1', text: 'a', done: false }] },
        })
    })
    it('omits undefined values but keeps null', () => {
        const out = splitValues(widgetHost, def, { name: 'N', due: undefined, severity: null })
        expect(out.columns).toEqual({ name: 'N' })
        expect(out.fields).toEqual({ severity: null })
    })
})

describe('mergeValues', () => {
    it('reads columns and the json column back into one values object', () => {
        const record = {
            id: 'w1',
            name: 'N',
            notes: '',
            due: '2026-01-02',
            owner: 'u',
            position: 'a0',
            form: 'f1',
            fields: { severity: 'low', count: 2 },
        }
        const values = mergeValues(widgetHost, def, record, {
            tasks: [{ id: 't1', text: 'a', done: false }],
        })
        expect(values).toEqual({
            name: 'N',
            notes: '',
            due: '2026-01-02',
            owner: 'u',
            severity: 'low',
            count: 2,
            tasks: [{ id: 't1', text: 'a', done: false }],
        })
    })
    it('tolerates a null json column', () => {
        const record = { id: 'w1', name: 'N', fields: null }
        expect(mergeValues(widgetHost, def, record)).toMatchObject({ name: 'N' })
    })
})
