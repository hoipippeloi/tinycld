import { describe, expect, it } from 'vitest'
import { downgradeConfirmHint, downgradeConfirmSchema } from '../downgrade-confirm-schema'

const valid = (slugs: string[], confirm: string) =>
    downgradeConfirmSchema(slugs).safeParse({ confirm }).success

describe('downgradeConfirmSchema', () => {
    it('is valid with nothing typed when there is no downgrade', () => {
        expect(valid([], '')).toBe(true)
    })

    it('accepts the single downgraded slug with surrounding whitespace', () => {
        expect(valid(['todo'], '  todo ')).toBe(true)
    })

    it('rejects an empty or wrong slug', () => {
        expect(valid(['todo'], '')).toBe(false)
        expect(valid(['todo'], 'tod')).toBe(false)
        expect(valid(['todo'], 'Todo')).toBe(false)
    })

    it('requires every downgraded slug, separated by commas or spaces', () => {
        expect(valid(['mail', 'drive'], 'mail')).toBe(false)
        expect(valid(['mail', 'drive'], 'drive, mail')).toBe(true)
        expect(valid(['mail', 'drive'], 'mail drive')).toBe(true)
        expect(valid(['mail', 'drive'], 'mail,drive,calendar')).toBe(true)
    })

    it('reports the hint on the confirm field', () => {
        const result = downgradeConfirmSchema(['mail', 'drive']).safeParse({ confirm: 'mail' })
        expect(result.error?.issues[0]?.path).toEqual(['confirm'])
        expect(result.error?.issues[0]?.message).toBe(
            'Type each package name to confirm: mail, drive'
        )
    })
})

describe('downgradeConfirmHint', () => {
    it('names a single slug directly', () => {
        expect(downgradeConfirmHint(['todo'])).toBe('Type todo to confirm')
    })
})
