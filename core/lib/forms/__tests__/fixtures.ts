import type { FormDefinition } from '../definition'
import type { FormHostDef } from '../host'

export const bugDefinition: FormDefinition = {
    version: 1,
    pages: [
        { key: 'details', title: 'Details' },
        { key: 'repro', title: 'Reproduction' },
    ],
    fields: [
        {
            key: 'title',
            kind: 'builtin',
            page: 'details',
            label: 'Title',
            width: 'full',
            required: true,
            hidden: false,
        },
        {
            key: 'severity',
            kind: 'select',
            page: 'details',
            label: 'Severity',
            width: 'third',
            required: false,
            hidden: false,
            display: 'dropdown',
            multiple: false,
            options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
            ],
        },
        {
            key: 'steps',
            kind: 'markdown',
            page: 'repro',
            label: 'Steps',
            width: 'full',
            required: false,
            hidden: false,
            collaborative: true,
        },
    ],
    rules: [
        {
            key: 'r1',
            match: 'all',
            when: [{ field: 'severity', op: 'is', value: 'high' }],
            actions: [
                { action: 'require', field: 'steps' },
                { action: 'show', page: 'repro' },
            ],
        },
    ],
    defaults: { severity: 'low' },
    submit: { required: ['title'] },
}

export const widgetHost: FormHostDef = {
    key: 'gizmos:widget',
    label: 'Widget',
    collection: 'gizmos_widgets',
    formColumn: 'form',
    fieldsColumn: 'fields',
    columns: ['name', 'notes', 'due', 'owner', 'position'],
    builtin: [
        { key: 'name', label: 'Name', kind: 'text', storage: 'column', required: true },
        {
            key: 'notes',
            label: 'Notes',
            kind: 'markdown',
            storage: 'column',
            collaborative: true,
            component: 'NotesField',
        },
        { key: 'due', label: 'Due', kind: 'date', storage: 'column' },
        { key: 'owner', label: 'Owner', kind: 'user', storage: 'column' },
        { key: 'tasks', label: 'Tasks', kind: 'checklist', storage: 'rows', mapper: 'tasksMapper' },
        {
            key: 'comments',
            label: 'Comments',
            kind: 'section',
            storage: 'none',
            component: 'CommentsSection',
        },
    ],
    files: {
        collection: 'gizmos_files',
        recordColumn: 'widget',
        fieldColumn: 'field',
        sizeColumn: 'size',
        uploaderColumn: 'uploaded_by',
    },
    collaborative: { fragment: 'widget:{record}:{format}:{key}' },
}
