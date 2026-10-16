import { packageSidebarContributions } from '@tinycld/core/lib/packages/derive-components'
import { Suspense } from 'react'

interface SidebarSlotProps {
    target: string
    slot: string
    // Passed to every contributed component. A slot documents its own props
    // contract (for example GroupMemberRemovalNoticeProps).
    props?: Record<string, unknown>
}

export function SidebarSlot({ target, slot, props }: SidebarSlotProps) {
    const entries = packageSidebarContributions[target]?.[slot]
    if (!entries || entries.length === 0) return null
    return (
        <>
            {entries.map(entry => {
                const Component = entry.Component
                return (
                    <Suspense key={entry.contributorSlug} fallback={null}>
                        <Component {...props} />
                    </Suspense>
                )
            })}
        </>
    )
}
