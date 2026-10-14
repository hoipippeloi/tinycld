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
    /** Set when the host hook created the form; lets a picker reach the host's own queries. */
    hostContext?: Record<string, unknown>
}

export interface FormHostUi {
    components: Record<string, ComponentType<BuiltinFieldProps>>
    mappers: Record<string, RowMapper>
    useDoc?: (recordId: string) => CollabDoc | null
}
