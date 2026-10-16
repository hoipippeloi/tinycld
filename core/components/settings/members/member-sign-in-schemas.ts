import { newPasswordSchema } from '@tinycld/core/components/workspace/sign-in/mfa-schemas'
import { z } from '@tinycld/core/ui/form'

// Same rules as the password the member then chooses for themselves.
export const temporaryPasswordSchema = newPasswordSchema

export const resetEmailSchema = z.object({
    email: z.string().trim().email('Enter a valid email address'),
})
