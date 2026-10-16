import { type FormHostDef, type FormHostDefInput, hostDefListSchema } from '../forms/host'
import type { FormHostUi } from '../forms/host-ui'

export interface FormHost extends FormHostDef {
    pkgSlug: string
    pkgName: string
    ui: () => Promise<FormHostUi>
}

type FormHostEntryLike = {
    manifest: { name: string; slug: string }
    formHosts?: FormHostDefInput[]
    formHostsUi?: () => Promise<{ default: FormHostUi }>
}

const EMPTY_UI: FormHostUi = { components: {} }

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
        // The generator already validated these; a throw here means it was bypassed.
        for (const h of hostDefListSchema.parse(e.formHosts))
            out.push({ ...h, pkgSlug: e.manifest.slug, pkgName: e.manifest.name, ui })
    }
    return out
}
