import { describe, expect, it } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { type DraftDefinition, newCustomField } from '../../../lib/forms/builder'
import { defaultDefinitionFor } from '../../../lib/forms/host'
import { describePath, errorLeaves, firstMessage } from '../editor-errors'

const base = defaultDefinitionFor(widgetHost)
const draft = {
    ...base,
    fields: [...base.fields, newCustomField('select', 'Severity', 'main', new Set())],
}

describe('describePath', () => {
    it('names a field and the property at fault by its label', () => {
        expect(describePath('fields.6.options', draft)).toBe("Field 'Severity', options")
        expect(describePath('fields.6.options.0.value', draft)).toBe("Field 'Severity', options")
        expect(describePath('fields.6', draft)).toBe("Field 'Severity'")
        expect(describePath('fields.6.acceptText', draft)).toBe("Field 'Severity', accepted types")
        expect(describePath('fields.6.maxLength', draft)).toBe("Field 'Severity', maximum length")
    })
    it('counts rules, conditions and actions from one', () => {
        expect(describePath('rules.0.when.1.value', draft)).toBe('Rule 1, condition 2')
        expect(describePath('rules.2.actions.0.field', draft)).toBe('Rule 3, action 1')
        expect(describePath('rules.0.when', draft)).toBe('Rule 1, conditions')
        expect(describePath('rules.0.actions.root', draft)).toBe('Rule 1, actions')
        expect(describePath('rules.1.key', draft)).toBe('Rule 2')
    })
    it('names pages, defaults and the required-on-submit list', () => {
        expect(describePath('pages.0.title', draft)).toBe("Page 'Widget'")
        expect(describePath('defaults.severity', draft)).toBe("Field 'Severity', default")
        expect(describePath('defaults.gone', draft)).toBe("Field 'gone', default")
        expect(describePath('submit.required.0', draft)).toBe('Required on submit')
    })
    it('reads the form as a whole as no place at all', () => {
        expect(describePath('root', draft)).toBe('')
        expect(describePath('', draft)).toBe('')
        expect(describePath('fields', draft)).toBe('Fields')
    })
    it('falls back to a position for a field that is gone', () => {
        expect(describePath('fields.40.label', draft)).toBe('Field 41, label')
    })
})

describe('errorLeaves', () => {
    it('lists every message with its path and skips element refs', () => {
        const errors = {
            root: { type: 'server', message: 'down' },
            fields: [
                undefined,
                { label: { type: 'custom', message: 'empty', ref: { message: 'not an error' } } },
            ],
        }
        expect(errorLeaves(errors)).toEqual([
            { path: 'root', type: 'server', message: 'down' },
            { path: 'fields.1.label', type: 'custom', message: 'empty' },
        ])
        expect(firstMessage(errors.fields)).toBe('empty')
        expect(firstMessage(undefined)).toBeUndefined()
    })
})

describe('describePath for tables and formulas', () => {
    const tableDraft: DraftDefinition = {
        ...base,
        fields: [
            ...base.fields,
            {
                key: 'parts',
                kind: 'table',
                page: 'main',
                label: 'Parts',
                width: 'full',
                required: false,
                hidden: false,
                columns: [
                    { key: 'qty', kind: 'number', label: 'Qty', required: false, hidden: false },
                    {
                        key: 'total',
                        kind: 'computed',
                        label: 'Total',
                        required: false,
                        hidden: false,
                        decimals: 0,
                        expression: 0,
                    },
                ],
            },
            newCustomField('computed', 'Grand total', 'main', new Set()),
        ],
    }

    it('names a column by its label, then the property at fault', () => {
        expect(describePath('fields.6.columns.0.label', tableDraft)).toBe(
            "Field 'Parts', column 'Qty', label"
        )
        expect(describePath('fields.6.columns.1.expression', tableDraft)).toBe(
            "Field 'Parts', column 'Total', formula"
        )
        expect(describePath('fields.6.columns.0.options.1.value', tableDraft)).toBe(
            "Field 'Parts', column 'Qty', options"
        )
        expect(describePath('fields.6.columns.0', tableDraft)).toBe("Field 'Parts', column 'Qty'")
        expect(describePath('fields.6.columns.5.key', tableDraft)).toBe(
            "Field 'Parts', column 6, key"
        )
        expect(describePath('fields.6.columns', tableDraft)).toBe("Field 'Parts', columns")
    })

    it("names a calculated value's formula and decimal places", () => {
        expect(describePath('fields.7.expression', tableDraft)).toBe("Field 'Grand total', formula")
        expect(describePath('fields.7.decimals', tableDraft)).toBe(
            "Field 'Grand total', decimal places"
        )
    })
})
