// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import { gizmos, partsDefinition } from '../../../lib/forms/__tests__/table-fixtures'
import { definitionSchema } from '../../../lib/forms/definition'
import type { FormValues } from '../../../lib/forms/logic'
import { useFormState } from '../use-form-state'

const ctx = { today: '2026-01-01', userId: 'u' }
const def = definitionSchema.parse({
    ...partsDefinition,
    fields: [
        ...partsDefinition.fields,
        { key: 'big_note', kind: 'text', page: 'main', label: 'Big order note', hidden: true },
    ],
    rules: [
        {
            key: 'big',
            when: [{ field: 'total_qty', op: 'gt', value: 5 }],
            actions: [{ action: 'show', field: 'big_note' }],
        },
    ],
})

function useHarness() {
    const form = useForm<FormValues>({
        defaultValues: { parts: [{ id: 'a', label: 'A', qty: 2 }] },
    })
    return { form, ...useFormState(def, gizmos, form.control, ctx) }
}

describe('useFormState computed values', () => {
    it('returns live computed values and evaluates rules on them', () => {
        const { result } = renderHook(useHarness)
        expect(result.current.computed.total_qty).toBe(2)
        expect(result.current.computed.parts).toEqual([{ id: 'a', label: 'A', qty: 2, double: 4 }])
        expect(result.current.state.fields.big_note.visible).toBe(false)
        act(() => result.current.form.setValue('parts', [{ id: 'a', label: 'A', qty: 6 }]))
        expect(result.current.computed.total_qty).toBe(6)
        expect(result.current.state.fields.big_note.visible).toBe(true)
    })
})
