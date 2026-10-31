import type { ComponentType } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { HostSchemas, TableRow } from './values'

/** Set when a host component draws one cell of a table built-in. */
export interface TableCellContext {
    columnKey: string
    rowIndex: number
    /** The row's current cells, computed cells filled. */
    row: TableRow
    /** Sets several cells of this row in one change, such as a rate picked with a product. */
    onRowChange: (cells: Record<string, unknown>) => void
}

export interface CollabDoc {
    doc: Y.Doc
    awareness: Awareness | null
    user: { id: string; name: string; color: string } | null
    canEdit: boolean
}

export type FieldMode = 'create' | 'edit' | 'design' | 'read'

export interface BuiltinFieldProps {
    fieldKey: string
    label: string
    recordId?: string
    value: unknown
    onChange: (value: unknown) => void
    mode: FieldMode
    /** Read-only or a design canvas: the component shows the value and offers no edit. */
    disabled: boolean
    /** The room, when the field is collaborative and the screen opened one. */
    collab?: CollabDoc | null
    /** The fragment name resolved from the host's template, for a collaborative field. */
    fragment?: string
    /** Only when the component draws a table cell: `value` and `onChange` are then the cell's. */
    table?: TableCellContext
}

export interface FormHostUi {
    components: Record<string, ComponentType<BuiltinFieldProps>>
    /**
     * A row the host draws ABOVE a built-in's cell, keyed by the built-in's
     * component name like `components`, and rendered with the same props. The
     * sections layout gives it a row of its own; when the renderer owns the
     * scroll view (`scroll`), that row pins to the top while the field scrolls
     * past. Edit and read modes only: the create wizard and the design canvas
     * never render it. A pinned field splits its page into separate rows, so
     * half-width cells before and after it do not share a line.
     */
    pinned?: Record<string, ComponentType<BuiltinFieldProps>>
    useDoc?: (recordId: string) => CollabDoc | null
    /**
     * The value schema of a custom built-in whose component has one, keyed by
     * component name like `components`. Its issue messages are the field's
     * inline text, and a refusal blocks the save.
     */
    schemas?: HostSchemas
}
