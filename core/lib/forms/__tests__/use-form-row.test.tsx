// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultDefinitionFor } from '../host'
import { useFormRow } from '../use-forms-of-host'
import { widgetHost } from './fixtures'

const rows = [{ id: 'f1', host: 'gizmos:widget', definition: defaultDefinitionFor(widgetHost) }]
vi.mock('@tinycld/core/lib/pocketbase', () => ({ useStore: () => [{}] }))
vi.mock('@tanstack/react-db', () => ({ useLiveQuery: () => ({ data: rows, isReady: true }) }))

describe('useFormRow', () => {
    it('returns the parsed row', () => {
        const { result } = renderHook(() => useFormRow('f1'))
        expect(result.current.row?.id).toBe('f1')
        expect(result.current.isReady).toBe(true)
    })
})
