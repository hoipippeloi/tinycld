import { z } from 'zod'

export const keySchema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores')
