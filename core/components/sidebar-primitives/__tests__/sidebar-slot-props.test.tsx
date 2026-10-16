// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tinycld/core/lib/packages/derive-components', () => {
    const Notice = ({ groupId }: { groupId?: string }) => <Text>{`notice ${groupId}`}</Text>
    return {
        packageSidebarContributions: {
            core: {
                'group-member-removal': [{ contributorSlug: 'zoo_keepers', Component: Notice }],
            },
        },
    }
})

import { hasSlotContributions, SidebarSlot } from '../SidebarSlot'

afterEach(cleanup)

describe('SidebarSlot props', () => {
    it('passes props to every contributed component', () => {
        const { getByText } = render(
            <SidebarSlot
                target="core"
                slot="group-member-removal"
                props={{ groupId: 'g1', userId: 'u1' }}
            />
        )
        expect(getByText('notice g1')).not.toBeNull()
    })

    it('tells a host whether any package contributes to a slot', () => {
        expect(hasSlotContributions('core', 'group-member-removal')).toBe(true)
        expect(hasSlotContributions('core', 'zoo-feeding-times')).toBe(false)
        expect(hasSlotContributions('zoo_keepers', 'group-member-removal')).toBe(false)
    })
})
