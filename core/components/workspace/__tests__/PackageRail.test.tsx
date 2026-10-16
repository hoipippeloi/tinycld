// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useWorkspaceStore } from '@tinycld/core/lib/stores/workspace-store'
import { Link } from 'expo-router'
import { Star } from 'lucide-react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageRailItem } from '../PackageRail'

const item = (isActive: boolean) => (
    <PackageRailItem
        slug="gizmos"
        label="Gizmos"
        Icon={Star}
        isActive={isActive}
        activeColor="#000"
        textColor="#000"
    />
)

describe('a package rail item', () => {
    beforeEach(() => {
        vi.mocked(Link).mockClear()
        useWorkspaceStore.setState({ lastPackageHref: { gizmos: '/a/gizmos/42' } })
    })
    afterEach(cleanup)

    it('links to where the package was left', () => {
        render(item(false))
        expect(vi.mocked(Link).mock.calls[0]?.[0]).toMatchObject({ href: '/a/gizmos/42' })
    })

    it('is inert for the open package', () => {
        const { container } = render(item(true))
        expect(Link).not.toHaveBeenCalled()
        // The RN element stub writes testID as a lower-cased attribute.
        expect(container.querySelector('[testid="nav-gizmos"]')).not.toBeNull()
    })
})
