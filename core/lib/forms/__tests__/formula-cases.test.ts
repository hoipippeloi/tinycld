import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { computeExprSchema, evalCompute } from '../expression'
import table from '../fixtures/formula-cases.json'

// The shared formula table: the report compiler runs every case
// (core/server/reports/formula_cases_test.go); the forms engines, TS here and
// Go in core/server/forms/formula_cases_test.go, run each case that carries a
// "forms" formula. A shared case's expected value holds for both.
const caseSchema = z.object({
    name: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    forms: z.unknown().optional(),
    expect: z.unknown().optional(),
})

const shared = z
    .array(caseSchema)
    .parse(table.cases)
    .filter(c => c.forms !== undefined)

describe('the shared formula table in the forms engine', () => {
    it('shares enough cases with the report compiler', () => {
        expect(shared.length).toBeGreaterThanOrEqual(20)
    })

    for (const c of shared) {
        it(c.name, () => {
            const formula = computeExprSchema.parse(c.forms)
            const scope = { ...c.values, ...(c.rows ? { rows: c.rows } : {}) }
            expect(evalCompute(formula, scope)).toBe(c.expect)
        })
    }
})
