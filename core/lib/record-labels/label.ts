// Pure, no React and no store: the generator imports this module in Node to
// validate a manifest's `recordLabels`, and the relation pickers use it at
// runtime. Keep it free of imports that only resolve inside the app.

/**
 * How core's relation pickers name a record of one collection. Declared by
 * the package that owns the collection, in its manifest's `recordLabels`.
 *
 * `format` is literal text with placeholders: `{field}` reads a field of the
 * record, and `{relation.field}` reads a field of the record that the single
 * relation `relation` points at. `relations` names the collection behind each
 * relation that `format` reads through.
 *
 * ```ts
 * recordLabels: {
 *     gizmo_tags: { format: '{code}-{family.name}', relations: { family: 'gizmo_families' } },
 * }
 * ```
 */
export interface RecordLabelDecl {
    format: string
    relations?: Record<string, string>
}

export type RecordLabelPart =
    | { kind: 'text'; text: string }
    | { kind: 'field'; field: string }
    | { kind: 'related'; field: string }

/** A parsed RecordLabelDecl, or the one-field label of the display-field fallback. */
export interface RecordLabel {
    parts: RecordLabelPart[]
    /** The record's own fields the label reads, in format order. */
    ownFields: string[]
    related?: { relation: string; collection: string; fields: string[] }
}

const NAME = /^[a-z][a-z0-9_]*$/
const PLACEHOLDER = /\{([^{}]*)\}/g

// A search term can have at most this many words. Each word that a related
// field can match adds the ids of the related rows it matched to the filter,
// and the realtime subscription topic carries that filter URL-encoded, so a
// long id list makes the topic too long for the server.
export const MAX_SEARCH_TOKENS = 2

function placeholderPart(body: string, relationsUsed: Set<string>): RecordLabelPart {
    const segments = body.split('.')
    if (segments.length > 2 || segments.some(s => !NAME.test(s))) {
        throw new Error(`placeholder '{${body}}' must be {field} or {relation.field}`)
    }
    if (segments.length === 1) return { kind: 'field', field: body }
    relationsUsed.add(segments[0])
    return { kind: 'related', field: segments[1] }
}

function tokenize(format: string, relationsUsed: Set<string>): RecordLabelPart[] {
    const parts: RecordLabelPart[] = []
    let cursor = 0
    for (const match of format.matchAll(PLACEHOLDER)) {
        const index = match.index ?? 0
        if (index > cursor) parts.push({ kind: 'text', text: format.slice(cursor, index) })
        parts.push(placeholderPart(match[1], relationsUsed))
        cursor = index + match[0].length
    }
    if (cursor < format.length) parts.push({ kind: 'text', text: format.slice(cursor) })
    for (const part of parts) {
        if (part.kind === 'text' && /[{}]/.test(part.text)) {
            throw new Error(`format '${format}' has an unmatched brace`)
        }
    }
    return parts
}

function resolveRelation(
    decl: RecordLabelDecl,
    relationsUsed: Set<string>,
    parts: RecordLabelPart[]
): RecordLabel['related'] {
    const declared = decl.relations ?? {}
    for (const [relation, collection] of Object.entries(declared)) {
        if (!NAME.test(relation) || !NAME.test(collection)) {
            throw new Error(
                `relation '${relation}: ${collection}' is not a valid field/collection name`
            )
        }
        if (!relationsUsed.has(relation)) {
            throw new Error(`relation '${relation}' is declared but the format never reads it`)
        }
    }
    // One relation keeps a picker to one extra query; a label that needs two
    // related records is a sign the collection should store the text itself.
    if (relationsUsed.size > 1) {
        throw new Error(`format reads ${relationsUsed.size} relations; a label may read only one`)
    }
    const [relation] = relationsUsed
    if (relation === undefined) return undefined
    const collection = declared[relation]
    if (!collection) {
        throw new Error(
            `format reads relation '${relation}' but relations does not name its collection`
        )
    }
    const fields = unique(parts.flatMap(p => (p.kind === 'related' ? [p.field] : [])))
    return { relation, collection, fields }
}

function unique(values: string[]): string[] {
    return [...new Set(values)]
}

/** Parses and validates a declaration. Throws an Error that says what is wrong. */
export function parseRecordLabel(decl: RecordLabelDecl): RecordLabel {
    const relationsUsed = new Set<string>()
    const parts = tokenize(decl.format, relationsUsed)
    if (!parts.some(p => p.kind !== 'text')) {
        throw new Error(`format '${decl.format}' has no {field} placeholder`)
    }
    const related = resolveRelation(decl, relationsUsed, parts)
    const ownFields = unique(parts.flatMap(p => (p.kind === 'field' ? [p.field] : [])))
    return related ? { parts, ownFields, related } : { parts, ownFields }
}

/** The label of a collection that declares none: one field, picked by the server's heuristic. */
export function fieldLabel(field: string): RecordLabel {
    return { parts: [{ kind: 'field', field }], ownFields: [field] }
}

function stringField(row: Record<string, unknown> | undefined, field: string): string {
    const value = row?.[field]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/**
 * The text a picker shows for `record`. `related` is the row the label's
 * relation points at, or undefined while it loads. A record whose fields are
 * all empty shows its id, so a menu item is never blank.
 */
export function renderRecordLabel(
    label: RecordLabel,
    record: Record<string, unknown>,
    related: Record<string, unknown> | undefined
): string {
    let hasValue = false
    const text = label.parts
        .map(part => {
            if (part.kind === 'text') return part.text
            const value = stringField(part.kind === 'field' ? record : related, part.field)
            if (value) hasValue = true
            return value
        })
        .join('')
    return hasValue ? text : stringField(record, 'id')
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Splits a search term into the words a record must all contain. The
 * label's own literal text separates words too, so a user who types the
 * whole label ("sales@example.com" for '{local_part}@{domain.domain}')
 * searches each field for its own part.
 */
export function searchTokens(label: RecordLabel, term: string): string[] {
    const separators = label.parts
        .flatMap(p => (p.kind === 'text' ? [p.text.trim()] : []))
        .filter(Boolean)
        .map(escapeRegExp)
    const splitter = new RegExp(['\\s+', ...separators].join('|'))
    return unique(term.split(splitter).filter(Boolean)).slice(0, MAX_SEARCH_TOKENS)
}

/**
 * Ids of the related rows whose label fields contain `token`. Case-sensitive,
 * the same as the `like` the picker's live query evaluates on the client.
 */
export function relatedIdsMatching(
    label: RecordLabel,
    token: string,
    rows: readonly Record<string, unknown>[]
): string[] {
    const fields = label.related?.fields ?? []
    return rows
        .filter(row => fields.some(field => stringField(row, field).includes(token)))
        .map(row => stringField(row, 'id'))
        .filter(Boolean)
}
