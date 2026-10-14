import { z } from 'zod'
import { CUSTOM_KINDS, type FormDefinition, keySchema } from './definition'

export const BUILTIN_KINDS = [...CUSTOM_KINDS, 'custom', 'section'] as const
export type BuiltinKind = (typeof BUILTIN_KINDS)[number]

const builtinSchema = z
    .object({
        key: keySchema,
        label: z.string().min(1).max(120),
        kind: z.enum(BUILTIN_KINDS),
        storage: z.enum(['column', 'rows', 'none']),
        required: z.boolean().default(false),
        multiple: z.boolean().default(false),
        collaborative: z.boolean().default(false),
        /** Export name in the host's UI module `components` map. */
        component: z.string().min(1).optional(),
        /** Key in the host's UI module `mappers` map; required for rows storage. */
        mapper: z.string().min(1).optional(),
    })
    .superRefine((b, ctx) => {
        if (b.storage === 'rows' && !b.mapper)
            ctx.addIssue({
                code: 'custom',
                path: ['mapper'],
                message: 'rows storage needs a mapper',
            })
        if (b.kind === 'section' && b.storage !== 'none')
            ctx.addIssue({ code: 'custom', path: ['storage'], message: 'a section has no storage' })
        if (b.kind === 'section' && !b.component)
            ctx.addIssue({
                code: 'custom',
                path: ['component'],
                message: 'a section needs a component',
            })
        if (b.kind === 'custom' && !b.component)
            ctx.addIssue({
                code: 'custom',
                path: ['component'],
                message: 'a custom kind needs a component',
            })
        if (b.collaborative && b.kind !== 'markdown' && b.kind !== 'richtext')
            ctx.addIssue({
                code: 'custom',
                path: ['collaborative'],
                message: 'only markdown and richtext can be collaborative',
            })
    })

/** Input types: a host declares only what differs from the defaults. */
export type FormHostBuiltin = z.input<typeof builtinSchema>

export const hostDefSchema = z.object({
    key: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/, 'host key is <slug>:<name>'),
    label: z.string().min(1).max(60),
    collection: z.string().min(1),
    formColumn: z.string().min(1),
    fieldsColumn: z.string().min(1),
    /** Every column of the collection, so a custom key can never shadow one. */
    columns: z.array(z.string().min(1)),
    builtin: z.array(builtinSchema).min(1),
    files: z
        .object({
            collection: z.string().min(1),
            recordColumn: z.string().min(1),
            fieldColumn: z.string().min(1),
            sizeColumn: z.string().min(1),
            uploaderColumn: z.string().min(1),
        })
        .optional(),
    collaborative: z
        .object({
            fragment: z.string().includes('{record}').includes('{key}').includes('{format}'),
        })
        .optional(),
})
export type FormHostDef = z.input<typeof hostDefSchema>
export const hostDefListSchema = z.array(hostDefSchema)

export function findBuiltin(host: FormHostDef, key: string): FormHostBuiltin | undefined {
    return host.builtin.find(b => b.key === key)
}

export function defaultDefinitionFor(host: FormHostDef): FormDefinition {
    return {
        version: 1,
        pages: [{ key: 'main', title: host.label }],
        fields: host.builtin.map(b => ({
            key: b.key,
            kind: 'builtin',
            page: 'main',
            label: b.label,
            width: 'full',
            required: b.required ?? false,
            hidden: false,
        })),
        rules: [],
        defaults: {},
        submit: { required: [] },
    }
}

export function resolveFragment(
    template: string,
    record: string,
    key: string,
    format: 'md' | 'html'
) {
    return template.replace('{record}', record).replace('{key}', key).replace('{format}', format)
}
