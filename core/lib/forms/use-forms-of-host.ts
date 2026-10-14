import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { log } from '@tinycld/core/lib/logger'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { definitionSchema } from './definition'

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
    const forms = (data ?? []).flatMap(row => {
        const parsed = definitionSchema.safeParse(row.definition)
        if (!parsed.success) {
            log.warn('forms.load', 'skipping invalid definition', { id: row.id })
            return []
        }
        return [{ ...row, definition: parsed.data }]
    })
    return { forms, defaultForm: forms.find(f => f.is_default), isReady: Boolean(isReady) }
}

export type FormRow = ReturnType<typeof useFormsOfHost>['forms'][number]
