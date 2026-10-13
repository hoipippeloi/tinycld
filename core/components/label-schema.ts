import { z } from '@tinycld/core/ui/form'

export const labelSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, 'Name is required')
        .max(50, 'Name must be 50 characters or fewer'),
    color: z.string().min(1, 'Pick a color'),
})

export type LabelValues = z.infer<typeof labelSchema>
