// @vitest-environment happy-dom
import { OverlayProvider as PortalHost } from '@gluestack-ui/core/overlay/creator'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
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
        org_pkg_access: mk('org_pkg_access', []),
        pkg_registry: mk('pkg_registry', []),
        mfa_totp: mk('mfa_totp', []),
        passkeys: mk('passkeys', []),
        app_passwords: mk('app_passwords', []),
    }
    return {
        useStore: (...names: string[]) => names.map(n => h.registry[n]),
    }
})

vi.mock('@tinycld/core/lib/packages/derive-components', () => ({
    get packageSidebarContributions() {
        return h.contributions
    },
}))

vi.mock('@tinycld/core/lib/use-avatar-url', () => ({ useAvatarUrl: () => null }))

vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'admin1', role: 'admin' } }),
}))

import { GroupDrawer } from '../../components/settings/groups/GroupDrawer'
import { MembersDrawer } from '../../components/settings/members/MembersDrawer'

const member = {
    userId: 'u1',
    username: 'ann',
    name: 'Ann',
    email: 'ann@x.test',
    role: 'member' as const,
    isPending: false,
    isDemo: false,
    avatar: '',
    avatarCrop: '',
    avatarColor: '',
    avatarEmoji: '',
}

const Panel = (props: { userId?: string; groupId?: string }) => (
    <Text testID="zoo-panel">
        {props.userId ? `userId:${props.userId}` : `groupId:${props.groupId}`}
    </Text>
)

const panel = (container: HTMLElement) =>
    container.ownerDocument.querySelector('[testid="zoo-panel"]')

function renderMembers() {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <OverlayProvider>
                <PortalHost>
                    <MembersDrawer
                        mode={{ kind: 'view', userId: 'u1' }}
                        onClose={() => {}}
                        members={[member]}
                        isCurrentUserOwner
                    />
                </PortalHost>
            </OverlayProvider>
        </QueryClientProvider>
    )
}

function renderGroup() {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <OverlayProvider>
                <PortalHost>
                    <GroupDrawer
                        mode={{ kind: 'view', groupId: 'g1' }}
                        onClose={() => {}}
                        onCreated={() => {}}
                    />
                </PortalHost>
            </OverlayProvider>
        </QueryClientProvider>
    )
}

beforeEach(() => {
    h.contributions = {
        core: {
            'member-drawer': [{ contributorSlug: 'zoo_keepers', Component: Panel }],
            'group-drawer': [{ contributorSlug: 'zoo_keepers', Component: Panel }],
        },
    }
})
afterEach(cleanup)

describe('member and group drawer slots', () => {
    it('renders member-drawer contributions with the viewed person id', async () => {
        const { container } = renderMembers()
        expect(panel(container)?.textContent).toBe('userId:u1')
    })

    it('renders group-drawer contributions with the group id', async () => {
        const { container, findByText } = renderGroup()
        await findByText('Ann')
        expect(panel(container)?.textContent).toBe('groupId:g1')
    })

    it('renders the drawers unchanged when no package contributes', async () => {
        h.contributions = {}
        const members = renderMembers()
        expect(panel(members.container)).toBeNull()
        expect(members.getByText('Role')).not.toBeNull()
        cleanup()
        const groups = renderGroup()
        await groups.findByText('Ann')
        expect(panel(groups.container)).toBeNull()
    })
})
