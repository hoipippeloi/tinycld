import { z } from '@tinycld/core/ui/form'

// Authenticator apps show six digits, often split "123 456"; spaces are
// dropped before the check so a pasted code works as typed.
export const totpCodeSchema = z.object({
    code: z
        .string()
        .transform(v => v.replace(/\s+/g, ''))
        .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app')),
})

// "abcde-fghij"; case, spaces and the dash are ignored by the server.
export const recoveryCodeSchema = z.object({
    recoveryCode: z
        .string()
        .transform(v => v.replace(/[\s-]+/g, ''))
        .pipe(
            z.string().regex(/^[a-zA-Z0-9]{10}$/, 'Enter one of your 10-character recovery codes')
        ),
})
