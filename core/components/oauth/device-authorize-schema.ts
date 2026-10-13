import { z } from '@tinycld/core/ui/form'

// A user_code is short enough to type by hand from a terminal prompt (e.g.
// "WDJB-MJHT"), so the info lookup only fires once enough characters exist —
// this avoids a request-per-keystroke against /oauth/authorize/info while
// still working for a code pasted or pre-filled from the URL in one shot.
export const MIN_USER_CODE_LENGTH = 9

// oauth_grants.device_label is a text field with max 200.
export const MAX_DEVICE_LABEL_LENGTH = 200

export const deviceAuthorizeSchema = z.object({
    code: z.string().trim().toUpperCase().min(MIN_USER_CODE_LENGTH),
    // Optional: the server names a blank label "Unnamed device".
    deviceLabel: z.string().trim().max(MAX_DEVICE_LABEL_LENGTH),
})

/** The code to look up, or null while what was typed is not yet a full code. */
export function lookupUserCode(typed: string): string | null {
    const parsed = deviceAuthorizeSchema.shape.code.safeParse(typed)
    return parsed.success ? parsed.data : null
}
