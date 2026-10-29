import { act, fireEvent, render as renderBare } from '@testing-library/react'
import type { ReactElement } from 'react'
import { vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { newCustomField } from '../../../lib/forms/builder'
import type { FormDefinition, FormField, TableColumn } from '../../../lib/forms/definition'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import type { FormHost } from '../../../lib/forms/use-form-hosts'
import { OverlayProvider } from '../../../ui/overlay'
import { FieldProperties } from '../FieldProperties'
import { type EditorRow, useEditorForm } from '../use-editor-form'

/**
 * A Widget form with a table, two calculated values and fields a formula can
 * and cannot read, for the builder panel tests. Each test file mocks
 * `use-form-admin` to return `calcAdmin` (and the row and host hooks).
 */
export const partsColumns: TableColumn[] = [
    { key: 'item', kind: 'text', label: 'Item', required: false, hidden: false },
    { key: 'qty', kind: 'number', label: 'Qty', required: false, hidden: false },
    { key: 'price', kind: 'number', label: 'Price', required: false, hidden: false },
    {
        key: 'total',
        kind: 'computed',
        label: 'Total',
        required: false,
        hidden: false,
        decimals: 2,
        expression: { mul: [{ var: 'qty' }, { var: 'price' }] },
    },
]

const parts: FormField = {
    key: 'parts',
    kind: 'table',
    page: 'main',
    label: 'Parts',
    width: 'full',
    required: false,
    hidden: false,
    columns: partsColumns,
}

const tax: FormField = {
    key: 'tax',
    kind: 'computed',
    page: 'main',
    label: 'Tax',
    width: 'full',
    required: false,
    hidden: false,
    decimals: 2,
    expression: { var: 'grand_total' },
}

const base = defaultDefinitionFor(widgetHost)

export const calcDefinition: FormDefinition = {
    ...base,
    fields: [
        ...base.fields,
        newCustomField('number', 'Qty', 'main', new Set()),
        newCustomField('toggle', 'Rush', 'main', new Set()),
        newCustomField('text', 'Note', 'main', new Set()),
        parts,
        newCustomField('computed', 'Grand total', 'main', new Set()),
        tax,
    ],
}

/** Where each custom field sits in `calcDefinition.fields`; inputs are named by it. */
export const AT = { qty: 6, rush: 7, note: 8, parts: 9, grandTotal: 10, tax: 11 } as const

export const calcRow = {
    id: 'f1',
    host: 'gizmos:widget',
    name: 'Widget',
    slug: 'widget',
    is_default: true,
    archived: false,
    order: 0,
    definition: calcDefinition,
}

export const calcHost: FormHost = {
    ...widgetHost,
    pkgSlug: 'gizmos',
    pkgName: 'Gizmos',
    ui: async () => ({ components: {} }),
}

export const saveDefinition = vi.fn(
    async (_input: { id: string; definition: FormDefinition }) => {}
)

export const calcAdmin = {
    host: calcHost,
    forms: [calcRow],
    defaultForm: calcRow,
    isReady: true,
    saveDefinition: { mutateAsync: saveDefinition, isPending: false },
}

/** The definition the last save sent to the server. */
export function lastSaved(): FormDefinition | undefined {
    return saveDefinition.mock.calls.at(-1)?.[0].definition
}

// RN stub hosts carry `testID`; Menu rows are DOM elements with `data-testid`.
export const q = (c: ParentNode, id: string) =>
    c.querySelector(`[testID="${id}"], [data-testid="${id}"]`) as HTMLElement | null

// Menus, prompts and the delete confirm render through the overlay host.
export const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

export async function click(c: ParentNode, id: string) {
    await act(async () => {
        fireEvent.click(q(c, id) as HTMLElement)
    })
}

/** Opens a PickMenu (its chip is in `c`) and picks its row `${testID}-${id}` (in the overlay). */
export async function choose(c: ParentNode, testID: string, id: string) {
    await click(c, testID)
    await click(document.body, `${testID}-${id}`)
}

export async function typeInto(c: ParentNode, id: string, value: string) {
    await act(async () => {
        fireEvent.input(q(c, id) as HTMLElement, { target: { value } })
    })
}

let current: ReturnType<typeof useEditorForm> | null = null

/** The editor of the last rendered Harness. */
export function editor(): ReturnType<typeof useEditorForm> {
    if (!current) throw new Error('render <Harness> first')
    return current
}

interface HarnessProps {
    fieldKey: string
    row?: EditorRow
    host?: FormHost
}

export function Harness({ fieldKey, row = calcRow, host = calcHost }: HarnessProps) {
    const e = useEditorForm(row, host)
    current = e
    return <FieldProperties editor={e} fieldKey={fieldKey} />
}
