import type { ComponentType } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { ChecklistItem } from './values'

export interface CollabDoc {
    doc: Y.Doc
    awareness: Awareness | null
    user: { id: string; name: string; color: string } | null
    canEdit: boolean
}

export interface RowMapper {
    /** A live query over the host table, as checklist items. */
    useRows: (recordId: string) => { items: ChecklistItem[]; isReady: boolean }
    /** Mutations; each returns when the write is accepted locally. */
    useMutations: (recordId: string) => {
        insert: (item: ChecklistItem) => Promise<void>
        update: (item: ChecklistItem) => Promise<void>
        remove: (id: string) => Promise<void>
        reorder: (ids: string[]) => Promise<void>
    }
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
}

export interface FormHostUi {
    components: Record<string, ComponentType<BuiltinFieldProps>>
    mappers: Record<string, RowMapper>
    /**
     * A row the host draws ABOVE a built-in's cell, keyed by the built-in's
     * component name like `components`, and rendered with the same props. The
     * sections layout gives it a row of its own; when the renderer owns the
     * scroll view (`scroll`), that row pins to the top while the field scrolls
     * past. Edit and read modes only: the create wizard and the design canvas
     * never render it.
     */
    pinned?: Record<string, ComponentType<BuiltinFieldProps>>
    useDoc?: (recordId: string) => CollabDoc | null
}
