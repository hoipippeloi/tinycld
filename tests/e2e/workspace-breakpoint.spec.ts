import { expect, test } from '@playwright/test'
import { login, navigateToPackage } from '@tinycld/core/e2e-helpers'

// Proves WorkspaceLayout keeps the package screen mounted when the window
// crosses a breakpoint (desktop >= 1024, tablet >= 768, mobile < 768).
//
// The Books Chart of Accounts search field is the probe. Its text lives in the
// screen's own React state (no URL, store or persistence), so it survives only
// if the screen is NOT unmounted. A DOM expando set on the live <input> is the
// second signal: a remounted screen renders a brand-new node without it.
//
// Guards against WorkspaceLayout returning a different tree per breakpoint:
// a different parent or slot for PackageProviderWrapper/PackageTabs makes React
// remount the whole navigator on every mobile <-> tablet/desktop switch.

const DESKTOP = { width: 1280, height: 800 }
const TABLET = { width: 800, height: 900 }
const MOBILE = { width: 390, height: 844 }
const MARKER = '__breakpointProbe'

test.describe('workspace layout: breakpoint changes', () => {
    test('a package screen keeps its state and DOM across desktop, mobile, tablet', async ({
        page,
    }) => {
        await page.setViewportSize(DESKTOP)
        await login(page)
        await navigateToPackage(page, 'books')

        const accounts = page.getByTestId('books-nav-accounts')
        const toggle = page.getByTestId('books-nav-accounting-toggle')
        await toggle.waitFor({ state: 'attached' })
        if (!(await accounts.isVisible())) await toggle.click()
        await accounts.click()

        const search = page.getByTestId('account-search')
        await search.fill('rent')
        await search.evaluate((el, key) => {
            ;(el as unknown as Record<string, boolean>)[key] = true
        }, MARKER)

        for (const size of [MOBILE, DESKTOP, TABLET, MOBILE]) {
            await page.setViewportSize(size)
            await expect(search, `search field at ${size.width}px`).toHaveValue('rent')
            const sameNode = await search.evaluate(
                (el, key) => (el as unknown as Record<string, boolean>)[key] === true,
                MARKER
            )
            expect(sameNode, `same DOM node at ${size.width}px`).toBe(true)
        }
    })
})
