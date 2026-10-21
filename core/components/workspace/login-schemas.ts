import { z } from '@tinycld/core/ui/form'

// The identifier is a username or an email address the server hosts, so it is
// only required here; the server decides which one it is. The password is never trimmed: a space is a
// legal password character.
export const loginSchema = z.object({
    identifier: z.string().trim().min(1, 'Enter your username or email address'),
    password: z.string().min(1, 'Enter your password'),
})

export const resetRequestSchema = z.object({
    email: z.string().trim().email('Enter a valid email address'),
})
