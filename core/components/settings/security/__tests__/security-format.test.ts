import { describe, expect, it } from 'vitest'
import { qrPath } from '../qr-matrix'
import { formatSince, proofFromInput } from '../security-format'

describe('proofFromInput', () => {
    it('treats six digits as an authenticator code, spaces allowed', () => {
        expect(proofFromInput('123 456')).toEqual({ code: '123456' })
    })

    it('treats anything else as a recovery code', () => {
        expect(proofFromInput('abcde-fghij')).toEqual({ recoveryCode: 'abcde-fghij' })
        expect(proofFromInput('1234567')).toEqual({ recoveryCode: '1234567' })
    })
})

describe('formatSince', () => {
    it('returns empty for a missing or bad date', () => {
        expect(formatSince('')).toBe('')
        expect(formatSince('not a date')).toBe('')
    })

    it('formats a date', () => {
        expect(formatSince('2026-10-03 12:00:00.000Z')).toMatch(/2026/)
    })
})

describe('qrPath', () => {
    it('draws a square code with dark modules', () => {
        const { path, size } = qrPath(
            'otpauth://totp/example.com:ada@example.com?secret=JBSWY3DPEHPK3PXP'
        )
        expect(size).toBeGreaterThanOrEqual(21)
        expect(path.startsWith('M')).toBe(true)
    })
})
