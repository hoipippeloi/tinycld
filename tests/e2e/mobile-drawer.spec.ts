import { expect, type Page, test } from '@playwright/test'
import { authKeyInitScript } from './auth-key-helpers'
import { appShell, login, navigateToPackage } from './helpers'

// MobileDrawer is the left slide-in package sidebar on phones. It opens from a
// pan that starts in the 20px strip at the left edge; react-native-gesture-handler
// also listens for the mouse on web, so a real mouse drag drives it.
//
// The geometry assertions guard where the drawer is MOUNTED. It must be a
// sibling of the shell row, not a child of the row below DemoBanner: inside the
// row its `top: 0` is the row's top, so in a demo session the panel and backdrop
// started under the ribbon instead of covering it. Non-demo web has no banner
// and zero insets, so only the demo test can tell the two arrangements apart.

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
const PANEL_WIDTH = 280
const PB_TEST_URL = `http://127.0.0.1:${process.env.E2E_PORT ?? 7200}`

async function swipeOpenFromEdge(page: Page) {
    const y = PHONE.height / 2
    await page.mouse.move(5, y)
    await page.mouse.down()
    await page.mouse.move(100, y, { steps: 8 })
    await page.mouse.move(200, y, { steps: 8 })
    await page.mouse.up()
}

async function boxOf(page: Page, testId: string) {
    const box = await page.getByTestId(testId).boundingBox()
    if (!box) throw new Error(`${testId} has no layout box`)
    return box
}

// Books has a sidebar, so it gets a drawer. The package rail links only exist
// at desktop width, so navigate there, then shrink: the workspace keeps the
// screen mounted across the breakpoint. Wait for the redirect and the closed
// panel (the drawer's mount) before the swipe.
async function openBooksOnPhone(page: Page) {
    await page.setViewportSize(DESKTOP)
    await navigateToPackage(page, 'books')
    await page.setViewportSize(PHONE)
    // Shrinking makes the books index redirect to its mobile landing screen.
    // ActivePkgSync closes the drawer on every route change, so a swipe that
    // lands before the redirect settles is undone by it.
    await expect(page).toHaveURL(/\/a\/books\/lists/)
    await page.getByText('Chart of accounts', { exact: true }).waitFor({ state: 'visible' })
    await page.getByTestId('mobile-drawer-panel').waitFor({ state: 'attached' })
}

async function expectDrawerOpen(page: Page) {
    await expect.poll(async () => (await boxOf(page, 'mobile-drawer-panel')).x).toBe(0)
}

async function enterDemo(page: Page) {
    const res = await page.request.post(`${PB_TEST_URL}/api/demo/start`)
    expect(res.ok()).toBe(true)
    const auth = (await res.json()) as { token: string; record: unknown }
    await page.addInitScript(authKeyInitScript())
    await page.addInitScript(authValue => {
        window.localStorage.setItem(
            (window as unknown as { __PB_AUTH_KEY__: string }).__PB_AUTH_KEY__,
            authValue
        )
    }, JSON.stringify(auth))
    await page.goto('/')
    await appShell(page).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await expect(page.getByTestId('demo-banner-cta')).toBeVisible()
}

test.describe('mobile drawer', () => {
    test('an edge swipe opens a full-height drawer with the package sidebar', async ({ page }) => {
        await login(page)
        await openBooksOnPhone(page)

        await swipeOpenFromEdge(page)
        await expectDrawerOpen(page)

        const panel = page.getByTestId('mobile-drawer-panel')
        await expect(panel.getByTestId('books-nav-accounting-toggle')).toBeVisible()

        const panelBox = await boxOf(page, 'mobile-drawer-panel')
        expect(panelBox.width).toBe(PANEL_WIDTH)
        expect(panelBox.y).toBe(0)
        expect(panelBox.height).toBe(PHONE.height)

        const backdropBox = await boxOf(page, 'mobile-drawer-backdrop')
        expect(backdropBox.x).toBe(0)
        expect(backdropBox.y).toBe(0)
        expect(backdropBox.width).toBe(PHONE.width)
        expect(backdropBox.height).toBe(PHONE.height)
    })

    test('tapping the backdrop closes the drawer', async ({ page }) => {
        await login(page)
        await openBooksOnPhone(page)

        await swipeOpenFromEdge(page)
        await expectDrawerOpen(page)

        await page.mouse.click(PHONE.width - 20, PHONE.height / 2)

        await expect
            .poll(async () => {
                const box = await boxOf(page, 'mobile-drawer-panel')
                return box.x + box.width
            })
            .toBeLessThanOrEqual(0)
    })

    test('in a demo session the drawer covers the banner instead of starting below it', async ({
        page,
    }) => {
        await enterDemo(page)
        await openBooksOnPhone(page)

        // Without a banner of real height this test could not tell the two
        // mount points apart.
        const banner = await boxOf(page, 'demo-banner-cta')
        expect(banner.y + banner.height).toBeGreaterThan(0)

        await swipeOpenFromEdge(page)
        await expectDrawerOpen(page)

        const panelBox = await boxOf(page, 'mobile-drawer-panel')
        expect(panelBox.y).toBe(0)
        expect(panelBox.height).toBe(PHONE.height)

        const backdropBox = await boxOf(page, 'mobile-drawer-backdrop')
        expect(backdropBox.y).toBe(0)
        expect(backdropBox.height).toBe(PHONE.height)
    })
})
