import type { FormHost } from '../../packages/derive-form-hosts'
import { definitionSchema, type FormDefinition, type FormField } from '../definition'
import {
    defaultDefinitionFor,
    type FormHostDef,
    type FormHostDefInput,
    hostDefSchema,
} from '../host'
import { widgetHost } from './fixtures'

/** A fictional host as the renderer gets it: with its package and a UI loader. */
export function asFormHost(def: FormHostDef): FormHost {
    return { ...def, pkgSlug: 'gizmos', pkgName: 'Gizmos', ui: async () => ({ components: {} }) }
}

/** A host whose lines live in its own collection, with a host-drawn Item cell. */
export const orderHostInput: FormHostDefInput = {
    key: 'gizmos:order',
    label: 'Order',
    collection: 'gizmos_orders',
    formColumn: 'form',
    fieldsColumn: 'fields',
    columns: ['name', 'subtotal', 'form', 'fields'],
    builtin: [
        { key: 'name', label: 'Name', kind: 'text', storage: 'column', required: true },
        {
            key: 'lines',
            label: 'Lines',
            kind: 'table',
            storage: 'rows',
            columns: [
                {
                    key: 'item',
                    label: 'Item',
                    kind: 'text',
                    required: true,
                    component: 'ItemCell',
                },
                { key: 'qty', label: 'Qty', kind: 'number' },
                { key: 'rate', label: 'Rate', kind: 'number' },
                {
                    key: 'amount',
                    label: 'Amount',
                    kind: 'computed',
                    decimals: 2,
                    expression: { mul: [{ var: 'qty' }, { var: 'rate' }] },
                },
            ],
        },
        {
            key: 'subtotal',
            label: 'Subtotal',
            kind: 'computed',
            storage: 'column',
            decimals: 2,
            component: 'Money',
            expression: { sumOf: [{ var: 'lines' }, 'amount'] },
        },
    ],
}
export const orderHost = hostDefSchema.parse(orderHostInput)
export const orderFormHost = asFormHost(orderHost)
export const orderDefinition: FormDefinition = defaultDefinitionFor(orderHost)

export const gizmos = asFormHost(widgetHost)

/** A custom table in the record's JSON, one column of every kind, and a total over it. */
export const partsDefinition: FormDefinition = definitionSchema.parse({
    version: 1,
    pages: [{ key: 'main', title: 'Main' }],
    fields: [
        { key: 'name', kind: 'builtin', page: 'main', label: 'Name' },
        {
            key: 'parts',
            kind: 'table',
            page: 'main',
            label: 'Parts',
            columns: [
                { key: 'label', kind: 'text', label: 'Label', required: true },
                { key: 'qty', kind: 'number', label: 'Qty', required: true },
                { key: 'done', kind: 'toggle', label: 'Done' },
                { key: 'due', kind: 'date', label: 'Due' },
                {
                    key: 'size',
                    kind: 'select',
                    label: 'Size',
                    options: [
                        { value: 's', label: 'Small' },
                        { value: 'l', label: 'Large' },
                    ],
                },
                {
                    key: 'double',
                    kind: 'computed',
                    label: 'Double',
                    expression: { mul: [{ var: 'qty' }, 2] },
                },
            ],
        },
        {
            key: 'total_qty',
            kind: 'computed',
            page: 'main',
            label: 'Total qty',
            expression: { sumOf: [{ var: 'parts' }, 'qty'] },
        },
    ],
})

export function fieldOf(def: FormDefinition, key: string): FormField {
    const field = def.fields.find(f => f.key === key)
    if (!field) throw new Error(`no field ${key}`)
    return field
}

/** Rows as the engine keeps them: a value, maybe null, in every editable column. */
export const rowA = { id: 'a', label: 'A', qty: 1, done: null, due: null, size: null }
export const rowB = { id: 'b', label: 'B', qty: 2, done: null, due: null, size: null }
