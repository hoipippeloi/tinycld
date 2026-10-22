import { describe, expect, it } from 'vitest'
import { definitionSchema } from '../definition'
import { findBuiltin, hostDefSchema } from '../host'
import { orderHost, orderHostInput } from './table-fixtures'

describe('host table columns', () => {
    it('keeps the component a host column names', () => {
        expect(findBuiltin(orderHost, 'lines')?.columns?.[0]).toMatchObject({
            key: 'item',
            component: 'ItemCell',
            required: true,
        })
    })

    it('strips a component from a custom table column', () => {
        const def = definitionSchema.parse({
            version: 1,
            pages: [{ key: 'main', title: 'Main' }],
            fields: [
                {
                    key: 'parts',
                    kind: 'table',
                    page: 'main',
                    label: 'Parts',
                    columns: [
                        { key: 'label', kind: 'text', label: 'Label', component: 'ItemCell' },
                    ],
                },
            ],
        })
        const field = def.fields[0]
        expect(field.kind).toBe('table')
        expect(field.kind === 'table' && 'component' in field.columns[0]).toBe(false)
    })

    it('still rejects a host column of an unknown kind', () => {
        const bad = {
            ...orderHostInput,
            builtin: [
                {
                    key: 'lines',
                    label: 'Lines',
                    kind: 'table',
                    storage: 'rows',
                    columns: [{ key: 'blob', kind: 'blob', label: 'Blob' }],
                },
            ],
        }
        expect(hostDefSchema.safeParse(bad).success).toBe(false)
    })
})
