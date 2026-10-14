import type { FormHostDef } from '../forms/host'
import type { FormHostUi } from '../forms/host-ui'

export interface FormHost extends FormHostDef {
    pkgSlug: string
    ui: () => Promise<FormHostUi>
}

type FormHostEntryLike = {
    manifest: { name: string; slug: string }
    formHosts?: FormHostDef[]
    formHostsUi?: () => Promise<{ default: FormHostUi }>
}

const EMPTY_UI: FormHostUi = { components: {}, mappers: {} }

export function deriveFormHosts(entries: readonly FormHostEntryLike[]): FormHost[] {
    const out: FormHost[] = []
    for (const e of entries) {
        if (!e.formHosts) continue
        let cached: Promise<FormHostUi> | undefined
        const ui = () => {
            if (!cached)
                cached = e.formHostsUi
                    ? e.formHostsUi().then(m => m.default)
                    : Promise.resolve(EMPTY_UI)
            return cached
        }
        for (const h of e.formHosts) out.push({ ...h, pkgSlug: e.manifest.slug, ui })
    }
    return out
}
