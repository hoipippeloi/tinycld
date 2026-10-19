import { describe, expect, it } from 'vitest'
import {
    fieldLabel,
    MAX_SEARCH_TOKENS,
    parseRecordLabel,
    relatedIdsMatching,
    renderRecordLabel,
    searchTokens,
} from '../label'

// A fictional package: gizmo_tags rows hold a code and a relation to the
// gizmo_families row whose name completes the tag ("bolt@north.example").
const tagLabel = parseRecordLabel({
    format: '{code}@{family.name}',
    relations: { family: 'gizmo_families' },
})

describe('parseRecordLabel', () => {
    it('splits a format into text, own-field and related-field parts', () => {
        expect(tagLabel).toEqual({
            parts: [
                { kind: 'field', field: 'code' },
                { kind: 'text', text: '@' },
                { kind: 'related', field: 'name' },
            ],
            ownFields: ['code'],
            related: { relation: 'family', collection: 'gizmo_families', fields: ['name'] },
        })
    })

    it('needs no relations for a label of own fields only', () => {
        expect(parseRecordLabel({ format: '{first} {last}' })).toEqual({
            parts: [
                { kind: 'field', field: 'first' },
                { kind: 'text', text: ' ' },
                { kind: 'field', field: 'last' },
            ],
            ownFields: ['first', 'last'],
        })
    })

    it.each([
        [{ format: 'no placeholders' }, /no \{field\} placeholder/],
        [{ format: '{Code}' }, /must be \{field\} or \{relation\.field\}/],
        [{ format: '{a.b.c}' }, /must be \{field\} or \{relation\.field\}/],
        [{ format: '{}' }, /must be \{field\} or \{relation\.field\}/],
        [{ format: '{code' }, /unmatched brace/],
        [{ format: '{family.name}' }, /does not name its collection/],
        [
            { format: '{code}', relations: { family: 'gizmo_families' } },
            /declared but the format never reads it/,
        ],
        [
            {
                format: '{family.name}{maker.name}',
                relations: { family: 'gizmo_families', maker: 'gizmo_makers' },
            },
            /may read only one/,
        ],
        [{ format: '{family.name}', relations: { family: 'Gizmo Families' } }, /not a valid/],
    ])('rejects %j', (decl, message) => {
        expect(() => parseRecordLabel(decl)).toThrow(message)
    })
})

describe('renderRecordLabel', () => {
    it('joins own and related fields with the literal text', () => {
        const text = renderRecordLabel(
            tagLabel,
            { id: 't1', code: 'bolt', family: 'f1' },
            { id: 'f1', name: 'north.example' }
        )
        expect(text).toBe('bolt@north.example')
    })

    it('shows what it has while the related row loads', () => {
        expect(renderRecordLabel(tagLabel, { id: 't1', code: 'bolt' }, undefined)).toBe('bolt@')
    })

    it('falls back to the id when every field is empty', () => {
        expect(renderRecordLabel(tagLabel, { id: 't1', code: '' }, undefined)).toBe('t1')
        expect(renderRecordLabel(fieldLabel('name'), { id: 'u1' }, undefined)).toBe('u1')
    })
})

describe('searchTokens', () => {
    it('splits on whitespace and on the label literal text', () => {
        expect(searchTokens(tagLabel, 'bolt@north')).toEqual(['bolt', 'north'])
        expect(searchTokens(tagLabel, 'bolt north')).toEqual(['bolt', 'north'])
        expect(searchTokens(tagLabel, '@north')).toEqual(['north'])
    })

    it('keeps a term whole for a label with no literal text', () => {
        expect(searchTokens(fieldLabel('name'), 'a.b@c')).toEqual(['a.b@c'])
    })

    it('treats literal text as plain text, not a pattern', () => {
        const dotted = parseRecordLabel({ format: '{major}.{minor}' })
        expect(searchTokens(dotted, '1x2')).toEqual(['1x2'])
        expect(searchTokens(dotted, '1.2')).toEqual(['1', '2'])
    })

    it(`keeps at most ${MAX_SEARCH_TOKENS} distinct words`, () => {
        expect(searchTokens(fieldLabel('name'), 'a a b c d')).toEqual(['a', 'b'])
    })
})

describe('relatedIdsMatching', () => {
    it('returns the related rows whose label fields contain the word', () => {
        const rows = [
            { id: 'f1', name: 'north.example' },
            { id: 'f2', name: 'south.example' },
        ]
        expect(relatedIdsMatching(tagLabel, 'north', rows)).toEqual(['f1'])
        expect(relatedIdsMatching(tagLabel, 'example', rows)).toEqual(['f1', 'f2'])
        expect(relatedIdsMatching(tagLabel, 'west', rows)).toEqual([])
    })
})
