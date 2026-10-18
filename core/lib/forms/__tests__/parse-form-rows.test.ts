import { log } from '@tinycld/core/lib/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDefinitionFor } from '../host'
import { parseFormRows } from '../use-forms-of-host'
import { widgetHost } from './fixtures'

afterEach(() => vi.restoreAllMocks())

describe('parseFormRows', () => {
    const good = { id: 'f1', definition: defaultDefinitionFor(widgetHost) }
    const bad = { id: 'f2', definition: { version: 1, pages: [] } }

    it('keeps rows whose definition parses and drops the rest', () => {
        vi.spyOn(log, 'warn').mockImplementation(() => {})
        expect(parseFormRows([good, bad]).map(r => r.id)).toEqual(['f1'])
    })
    it('reports an invalid row once, not on every parse', () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
        const other = { ...bad, id: 'f3' }
        parseFormRows([other])
        parseFormRows([other])
        parseFormRows([other])
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith(
            'forms.load',
            'skipping invalid definition',
            expect.objectContaining({ id: 'f3' })
        )
    })
})
