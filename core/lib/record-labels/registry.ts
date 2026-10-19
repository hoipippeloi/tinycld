import { tinycldConfig } from '@tinycld/app-generated/tinycld-config'
import { log } from '@tinycld/core/lib/logger'
import { parseRecordLabel, type RecordLabel, type RecordLabelDecl } from './label'

type RecordLabelEntryLike = {
    manifest: { slug: string; recordLabels?: Readonly<Record<string, RecordLabelDecl>> }
}

/**
 * Collection name → the label its package declared. The generator already
 * rejects an invalid or duplicate declaration, so a parse error here means the
 * config was not generated from these manifests; that collection falls back
 * to the display-field label rather than breaking every picker.
 */
export function deriveRecordLabels(
    entries: readonly RecordLabelEntryLike[]
): Record<string, RecordLabel> {
    const labels: Record<string, RecordLabel> = {}
    for (const entry of entries) {
        const declared = entry.manifest.recordLabels ?? {}
        for (const [collection, decl] of Object.entries(declared)) {
            if (labels[collection]) continue
            try {
                labels[collection] = parseRecordLabel(decl)
            } catch (err) {
                log.error('record-labels.parse', err, { pkg: entry.manifest.slug, collection })
            }
        }
    }
    return labels
}

export const packageRecordLabels = deriveRecordLabels(tinycldConfig)
