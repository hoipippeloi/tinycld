import { z } from '@tinycld/core/ui/form'

// The operator may separate the slugs with commas, spaces or both.
function typedSlugs(typed: string): Set<string> {
    return new Set(typed.split(/[,\s]+/).filter(Boolean))
}

export function downgradeConfirmHint(downgradeSlugs: string[]): string {
    if (downgradeSlugs.length === 1) return `Type ${downgradeSlugs[0]} to confirm`
    return `Type each package name to confirm: ${downgradeSlugs.join(', ')}`
}

/**
 * The typed confirmation for a staged version change: valid only when the text
 * names every downgraded slug, so confirming one package can never silently
 * downgrade another. With no downgrades there is nothing to type and the form
 * is valid as it stands.
 */
export function downgradeConfirmSchema(downgradeSlugs: string[]) {
    return z.object({
        confirm: z.string().refine(value => {
            const typed = typedSlugs(value)
            return downgradeSlugs.every(slug => typed.has(slug))
        }, downgradeConfirmHint(downgradeSlugs)),
    })
}
