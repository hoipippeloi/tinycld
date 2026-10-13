import { z } from '@tinycld/core/ui/form'

// The server parses the address the same way (validateAltEmail), so a value
// that passes here is one it accepts.
export const inviteLinkSendSchema = z.object({
    email: z.string().trim().email('Enter a valid email address'),
})
