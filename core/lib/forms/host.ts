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
        /**
         * `bare`: on a record (edit and read) the host component draws its own
         * label, spacing and errors, and the cell is only the width wrapper.
         * The design canvas still draws the labelled cell.
         */
        chrome: z.enum(['cell', 'bare']).default('cell'),
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

export const hostDefSchema = z
    .object({
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
                /** Holds the file's display name. */
                nameColumn: z.string().min(1).default('name'),
                /** The PocketBase file field. */
                fileColumn: z.string().min(1).default('file'),
                /** Attachment column ← host record column, copied onto every upload (a required `project`, say). */
                copyColumns: z.record(z.string().min(1), z.string().min(1)).default({}),
            })
            .optional(),
        collaborative: z
            .object({
                fragment: z.string().includes('{record}').includes('{key}').includes('{format}'),
            })
            .optional(),
    })
    .superRefine((host, ctx) => {
        const keys = new Set<string>()
        host.builtin.forEach((b, i) => {
            if (keys.has(b.key))
                ctx.addIssue({
                    code: 'custom',
                    path: ['builtin', i, 'key'],
                    message: `duplicate built-in key ${b.key}`,
                })
            keys.add(b.key)
            if (b.collaborative && !host.collaborative)
                ctx.addIssue({
                    code: 'custom',
                    path: ['builtin', i, 'collaborative'],
                    message: 'collaborative builtins need a collaborative fragment template',
                })
        })
    })

/** Parsed host with defaults applied. Every consumer of parsed data uses these types. */
export type FormHostBuiltin = z.infer<typeof builtinSchema>
export type FormHostDef = z.infer<typeof hostDefSchema>
/** Hand-authored host module input, where defaulted fields may be omitted. */
export type FormHostDefInput = z.input<typeof hostDefSchema>
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
            required: b.required,
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
    return template
        .replaceAll('{record}', () => record)
        .replaceAll('{key}', () => key)
        .replaceAll('{format}', () => format)
}
