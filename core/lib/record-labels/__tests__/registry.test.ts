import { log } from '@tinycld/core/lib/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveRecordLabels } from '../registry'

afterEach(() => vi.restoreAllMocks())

describe('deriveRecordLabels', () => {
    it('keys each declared label by its collection', () => {
        const labels = deriveRecordLabels([
            { manifest: { slug: 'gizmo' } },
            {
                manifest: {
                    slug: 'widget',
                    recordLabels: {
                        widget_parts: {
                            format: '{code}@{family.name}',
                            relations: { family: 'widget_families' },
                        },
                        widget_bins: { format: 'Bin {number}' },
                    },
                },
            },
        ])
        expect(Object.keys(labels)).toEqual(['widget_parts', 'widget_bins'])
        expect(labels.widget_parts.related?.collection).toBe('widget_families')
        expect(labels.widget_bins.ownFields).toEqual(['number'])
    })

    it('leaves out a label that does not parse, so its pickers use the display field', () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {})
        const labels = deriveRecordLabels([
            { manifest: { slug: 'widget', recordLabels: { widget_bins: { format: 'none' } } } },
        ])
        expect(labels).toEqual({})
        expect(error).toHaveBeenCalledWith('record-labels.parse', expect.any(Error), {
            pkg: 'widget',
            collection: 'widget_bins',
        })
    })
})
