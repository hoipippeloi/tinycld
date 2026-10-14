import { expect, type Page, test } from '@playwright/test'
import { clearEmailLog, extractFirstLink, waitForEmailTo } from './email-log-helpers'
import { appShell, createInvitedUser, type InvitedUser } from './helpers'
import { totpCode } from './totp-helpers'

// An owner helping a member who cannot sign in: remove their two-step
// verification, give them a temporary password, or email a reset link to
// another address. Each test works on its own invited member.
test.describe('admin sign-in help', () => {
    let invited: InvitedUser
    let inviteePage: Page
    let closeInvitee: () => Promise<void>

    test.beforeEach(async ({ page }) => {
        const created = await createInvitedUser(page, 'signinhelp')
        invited = created.user
        inviteePage = created.inviteePage
        closeInvitee = created.close
    })

    test.afterEach(async () => {
        await closeInvitee()
    })

    // SPA navigation, as in invite-flow.spec.ts.
    async function openMember(page: Page) {
        await page.getByTestId('nav-settings').click()
        await page.getByText('Members', { exact: true }).click()
        await page.getByTestId(`member-row-${invited.username}`).click()
        await page.getByTestId('member-sign-in-help').waitFor({ state: 'visible' })
    }

    async function enrollAuthenticator(page: Page) {
        await page.getByLabel('User menu').click()
        await page.getByText('Settings', { exact: true }).click()
        const accountGroup = page.getByText('Account', { exact: true }).locator('..')
        await accountGroup.getByText('Security', { exact: true }).click()
        await page.getByTestId('totp-start').click()
        const secret =
            (await page.getByTestId('totp-secret').textContent())?.replace(/\s+/g, '') ?? ''
        await page.getByTestId('totp-confirm-code').fill(totpCode(secret))
        await page.getByTestId('totp-confirm').click()
        await page.getByTestId('recovery-codes-done').click()
        await expect(page.getByTestId('totp-on')).toBeVisible()
    }

    async function submitPassword(page: Page, password: string) {
        await page.evaluate(() => {
            window.localStorage.clear()
            window.sessionStorage.clear()
        })
        await page.goto('/')
        await page.getByTestId('identifier').fill(invited.username)
        await page.getByPlaceholder('Password').fill(password)
        await page.getByTestId('login-submit').click()
    }

    test('resets two-step verification and sets a temporary password the member must replace', async ({
        page,
    }) => {
        await enrollAuthenticator(inviteePage)

        await openMember(page)
        await expect(page.getByTestId('member-mfa-status')).toContainText('authenticator app')
        await page.getByTestId('member-mfa-reset').click()
        await page.getByText('Reset', { exact: true }).click()
        await expect(page.getByTestId('member-mfa-status')).toHaveText(
            'Two-step verification is off.'
        )

        await page.getByTestId('member-set-password').click()
        await page.getByTestId('member-temp-password').fill('Temporary123!')
        await page.getByTestId('member-temp-password-confirm').fill('Temporary123!')
        await page.getByTestId('member-temp-password-save').click()
        await expect(page.getByText(/Temporary password set/)).toBeVisible()

        // The temporary password opens only the "choose a new password" step.
        await submitPassword(inviteePage, 'Temporary123!')
        await expect(inviteePage.getByTestId('password-step')).toBeVisible()
        await inviteePage.getByTestId('new-password').fill('MemberChose123!')
        await inviteePage.getByTestId('new-password-confirm').fill('MemberChose123!')
        await inviteePage.getByTestId('new-password-submit').click()
        await expect(inviteePage.getByTestId('sign-in-notice')).toContainText('new password is set')

        await inviteePage.getByTestId('identifier').fill(invited.username)
        await inviteePage.getByPlaceholder('Password').fill('MemberChose123!')
        await inviteePage.getByTestId('login-submit').click()
        await appShell(inviteePage).waitFor({ state: 'visible', timeout: 15_000 })
    })

    test('emails a reset link to another address', async ({ page }) => {
        clearEmailLog()
        const elsewhere = `${invited.username}@elsewhere.example`
        await openMember(page)
        await page.getByTestId('member-send-reset').click()
        await expect(page.getByTestId('member-reset-email')).toHaveValue(invited.email)
        await page.getByTestId('member-reset-email').fill(elsewhere)
        await page.getByTestId('member-reset-email-send').click()
        await expect(page.getByText(`Reset link sent to ${elsewhere}`)).toBeVisible()

        const email = await waitForEmailTo(elsewhere)
        const link = extractFirstLink(email, /https?:\/\/[^\s"'<>]+\/reset-password\/[^\s"'<>]+/)
        expect(link).toContain('/reset-password/')
    })
})
