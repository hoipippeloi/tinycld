import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { log } from '@tinycld/core/lib/logger'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useMemo } from 'react'
import { definitionSchema } from './definition'

/** Rows already reported, so a bad definition logs once, not on every render. */
const warnedInvalid = new Set<string>()

/** Parses each row's definition, dropping (and reporting once) the ones that do not parse. */
export function parseFormRows<T extends { id: string; definition: unknown }>(rows: T[]) {
    return rows.flatMap(row => {
        const parsed = definitionSchema.safeParse(row.definition)
        if (!parsed.success) {
            if (!warnedInvalid.has(row.id)) {
                warnedInvalid.add(row.id)
                log.warn('forms.load', 'skipping invalid definition', {
                    id: row.id,
                    issues: parsed.error.issues.slice(0, 3),
                })
            }
            return []
        }
        return [{ ...row, definition: parsed.data }]
    })
}

export function useFormsOfHost(hostKey: string | undefined) {
    const [formsCollection] = useStore('forms')
    const { data, isReady } = useLiveQuery(
        query =>
            query
                .from({ f: formsCollection })
                .where(({ f }) => eq(f.host, hostKey ?? ''))
                .orderBy(({ f }) => f.order, 'asc'),
        [formsCollection, hostKey]
    )
    const forms = useMemo(() => parseFormRows(data ?? []), [data])
    return { forms, defaultForm: forms.find(f => f.is_default), isReady: Boolean(isReady) }
}

export type FormRow = ReturnType<typeof useFormsOfHost>['forms'][number]
