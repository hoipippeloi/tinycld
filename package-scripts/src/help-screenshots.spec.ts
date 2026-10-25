import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { login } from '@tinycld/core/e2e-helpers'
import { loadPlan, planFiles } from './help-screenshots'

const member = process.env.HELP_SCREENSHOTS_MEMBER ?? ''
const topic = process.env.HELP_SCREENSHOTS_TOPIC
const helpDir = path.join(member, 'help')
const imagesDir = path.join(helpDir, 'images')

const files = planFiles(await loadPlan(member), topic)

for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
        test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } })

        for (const { shot, light, dark } of files) {
            test(`${shot.name}`, async ({ page }) => {
                await login(page)
                await shot.setup(page)
                const out = path.join(helpDir, scheme === 'light' ? light : dark)
                const buffer = shot.target
                    ? await page.locator(shot.target).screenshot()
                    : await page.screenshot()
                fs.mkdirSync(imagesDir, { recursive: true })
                fs.writeFileSync(out, buffer)
            })
        }
    })
}
