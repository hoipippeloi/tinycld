import { z } from '@tinycld/core/ui/form'

export const shareEmailSchema = z.object({
    email: z.string().trim().email('Enter a valid email address'),
})

// Matches guestauth.CodeLength on the server: the emailed code is six digits.
export const shareCodeSchema = z.object({
    code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, 'Enter the 6-digit code'),
})
