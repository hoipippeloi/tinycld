import type { FormDefinition } from '../definition'

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
