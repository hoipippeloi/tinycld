import { lazy } from 'react'
import { describe, expect, it } from 'vitest'
import type { SidebarContribution } from '../config-types'
import type { SidebarContributionEntry } from '../derive-components'

// A slot that passes props documents its own contract, so a contribution's
// component may require them. These assignments must compile: tsc is the test.
interface ZooNoticeProps {
    enclosureId: string
    keeperId: string | null
}
const ZooNotice = ({ enclosureId }: ZooNoticeProps) => <>{enclosureId}</>
const LazyZooNotice = lazy(async () => ({ default: ZooNotice }))

describe('sidebar contribution component types', () => {
    it('accept a component that requires props, plain or lazy', () => {
        const plain: SidebarContribution = {
            target: 'core',
            slot: 'zoo-notice',
            order: 0,
            Component: ZooNotice,
        }
        const lazyOne: SidebarContribution = { ...plain, Component: LazyZooNotice }
        const entry: SidebarContributionEntry = {
            contributorSlug: 'zoo_keepers',
            order: 0,
            Component: LazyZooNotice,
        }
        expect([plain.Component, lazyOne.Component, entry.Component]).toHaveLength(3)
    })
})
