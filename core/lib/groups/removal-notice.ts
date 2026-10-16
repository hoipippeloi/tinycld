export const GROUP_MEMBER_REMOVAL_SLOT = 'group-member-removal'

/**
 * Core renders this slot inside the confirm dialog that removes a person from a
 * group (userId set) or deletes a group (userId null). A package shows what the
 * person or the members lose. It renders nothing when they lose nothing.
 */
export interface GroupMemberRemovalNoticeProps {
    groupId: string
    /** null: the whole group is being deleted. */
    userId: string | null
}
