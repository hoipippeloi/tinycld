import type { OffboardPlan } from '@tinycld/core/lib/account'
import { confirmTextSchema, z } from '@tinycld/core/ui/form'

export const offboardPlanSchema = z
    .object({
        mode: z.enum(['reassign', 'delete_my_data']),
        successor_user_id: z.string().optional(),
    })
    .refine(plan => plan.mode !== 'reassign' || Boolean(plan.successor_user_id), {
        message: 'Choose who inherits the content',
        path: ['successor_user_id'],
    }) satisfies z.ZodType<OffboardPlan>

/**
 * Self-delete confirms with the user's own email (any case). When a peer could
 * inherit the content, a plan must be chosen explicitly: a destructive option is
 * never pre-selected, and the picker shows exactly what the submit sends. With
 * no peers the picker is hidden and no plan is the deliberate leave-content path.
 */
export function deleteAccountSchemaFor(email: string, hasPeers: boolean) {
    return confirmTextSchema(email, { ignoreCase: true })
        .extend({ plan: offboardPlanSchema.optional() })
        .refine(values => !hasPeers || values.plan !== undefined, {
            message: 'Choose what happens to your files, documents and comments',
            path: ['plan'],
        })
}

/** Admin removal confirms with the member's display name, matched exactly. */
export function removeMemberSchemaFor(displayName: string) {
    return confirmTextSchema(displayName).extend({ plan: offboardPlanSchema.optional() })
}

/**
 * The plan an admin removal submits when the admin has not picked one:
 * reassign to the first peer when there is one, else delete. Derived during
 * render, so the default follows the peer list once it loads.
 */
export function defaultRemovalPlan(peers: { id: string }[]): OffboardPlan {
    const first = peers[0]
    if (first) return { mode: 'reassign', successor_user_id: first.id }
    return { mode: 'delete_my_data' }
}
