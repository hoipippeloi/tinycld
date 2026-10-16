// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { OverlayProvider } from '@tinycld/core/ui/overlay'
import { Text } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
    registry: {} as Record<string, unknown>,
    contributions: {} as Record<string, Record<string, unknown[]>>,
}))

vi.mock('@tinycld/core/lib/pocketbase', async () => {
    const { BasicIndex, createCollection, localOnlyCollectionOptions } = await import(
        '@tanstack/db'
    )
    const mk = <T extends { id: string }>(id: string, initialData: T[]) =>
        createCollection({
            ...localOnlyCollectionOptions({
                id: `${id}-${Math.random()}`,
                getKey: (r: T): string | number => r.id,
                initialData,
            }),
            autoIndex: 'eager',
            defaultIndexType: BasicIndex,
        })
    h.registry = {
        groups: mk('groups', [{ id: 'g1', name: 'Sales', description: '' }]),
        group_members: mk('group_members', [{ id: 'm1', group: 'g1', user: 'u1' }]),
        users: mk('users', [
            { id: 'u1', name: 'Ann', email: 'ann@x.test', role: 'member', disabled: false },
        ]),
    }
    return { useStore: (...names: string[]) => names.map(n => h.registry[n]) }
})

vi.mock('@tinycld/core/lib/packages/derive-components', () => ({
    get packageSidebarContributions() {
        return h.contributions
    },
}))

import { MembersSection } from '../../components/settings/groups/GroupDrawer'

type Membership = { id: string }
const memberships = () =>
    [...(h.registry.group_members as { state: Map<string, Membership> }).state.values()].length

function mount() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <OverlayProvider>
                <MembersSection groupId="g1" groupName="Sales" />
            </OverlayProvider>
        </QueryClientProvider>
    )
}

// The stub renders accessibilityLabel as a plain attribute, not aria-label.
function pressRemoveAnn(container: HTMLElement) {
    const button = container.querySelector('[accessibilitylabel="Remove Ann from group"]')
    if (!button) throw new Error('no remove button rendered')
    fireEvent.click(button)
}

const Notice = ({ groupId, userId }: { groupId?: string; userId?: string | null }) => (
    <Text>{`notice ${groupId} ${userId}`}</Text>
)

beforeEach(() => {
    // The collections live for the whole file, so restore the row a test deleted.
    const members = h.registry.group_members as {
        has: (id: string) => boolean
        insert: (row: unknown) => unknown
    }
    if (!members.has('m1')) members.insert({ id: 'm1', group: 'g1', user: 'u1' })
    h.contributions = {
        core: { 'group-member-removal': [{ contributorSlug: 'zoo_keepers', Component: Notice }] },
    }
})
afterEach(cleanup)

describe('MembersSection removal confirm', () => {
    it('asks first, shows the slot, and removes on confirm', async () => {
        const { container, getByText, findByText } = mount()
        await findByText('Ann')
        pressRemoveAnn(container)
        expect(getByText('notice g1 u1')).not.toBeNull()
        expect(getByText('Remove Ann from "Sales"?')).not.toBeNull()
        expect(memberships()).toBe(1)

        fireEvent.click(getByText('Remove'))
        await waitFor(() => expect(memberships()).toBe(0))
    })

    it('keeps the member on cancel', async () => {
        const { container, getByText, findByText, queryByText } = mount()
        await findByText('Ann')
        pressRemoveAnn(container)
        fireEvent.click(getByText('Cancel'))
        await waitFor(() => expect(queryByText('notice g1 u1')).toBeNull())
        expect(memberships()).toBe(1)
    })

    it('still confirms when no package contributes', async () => {
        h.contributions = {}
        const { container, getByText, findByText } = mount()
        await findByText('Ann')
        pressRemoveAnn(container)
        fireEvent.click(getByText('Remove'))
        await waitFor(() => expect(memberships()).toBe(0))
    })
})
