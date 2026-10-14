import { describe, expect, it } from 'vitest'
import { effectiveWidth, NARROW_BELOW, widthClass } from '../widths'

describe('effectiveWidth', () => {
    it('keeps widths at or above the breakpoint', () => {
        expect(effectiveWidth('quarter', NARROW_BELOW)).toBe('quarter')
        expect(effectiveWidth('third', 1000)).toBe('third')
    })
    it('collapses below the breakpoint: quarter to half, half and third to full', () => {
        expect(effectiveWidth('quarter', NARROW_BELOW - 1)).toBe('half')
        expect(effectiveWidth('half', 500)).toBe('full')
        expect(effectiveWidth('third', 500)).toBe('full')
        expect(effectiveWidth('full', 500)).toBe('full')
    })
    it('treats an unmeasured container as wide', () => {
        expect(effectiveWidth('quarter', 0)).toBe('quarter')
    })
})

describe('widthClass', () => {
    it('maps to basis classes', () => {
        expect(widthClass('full')).toBe('basis-full')
        expect(widthClass('half')).toBe('basis-1/2')
        expect(widthClass('third')).toBe('basis-1/3')
        expect(widthClass('quarter')).toBe('basis-1/4')
    })
})
