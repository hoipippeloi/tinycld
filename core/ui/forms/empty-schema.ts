import type { FormDefinition } from '@tinycld/core/lib/forms/definition'
import type { FormState } from '@tinycld/core/lib/forms/logic'

export const EMPTY_DEFINITION: FormDefinition = {
    version: 1,
    pages: [{ key: 'main', title: '' }],
    fields: [],
    rules: [],
    defaults: {},
    submit: { required: [] },
}

export const EMPTY_STATE: FormState = { fields: {}, pages: {}, activeRules: [], setValues: {} }
