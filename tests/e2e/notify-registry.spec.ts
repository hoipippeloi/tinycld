import { expect, test } from '@playwright/test'
import { login, navigateToPackage, skipWithoutShortcutStub } from './helpers'

// Core's suite installs no real package, so the shortcut-stub (scaffolded by
// tests/scripts/scaffold-shortcut-stub.ts) declares a notify event through its
// manifest. This proves a package's declared event reaches the toast with the
// policy the package gave it, without core naming any package.
test.describe('Notify registry', () => {
    test.skip(skipWithoutShortcutStub(), 'shortcut-stub not scaffolded in this workspace')

    test("a package's declared event shows as a toast with its variant", async ({ page }) => {
        await login(page)
        await navigateToPackage(page, 'shortcut-stub', {
            waitFor: page.getByText('Shortcut stub landing', { exact: true }),
        })

        await page.getByTestId('shortcut-stub-ping').click()

        const toast = page.getByTestId('toast-card').filter({ hasText: 'Pinged' })
        await expect(toast).toBeVisible()
        await expect(toast.getByTestId('toast-variant-info')).toBeVisible()
    })
})
