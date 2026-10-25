import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { login } from '@tinycld/core/e2e-helpers'
import { planFiles, type ScreenshotPlan } from './help-screenshots'

const member = process.env.HELP_SCREENSHOTS_MEMBER ?? ''
const topic = process.env.HELP_SCREENSHOTS_TOPIC
const helpDir = path.join(member, 'help')
const imagesDir = path.join(helpDir, 'images')

async function loadPlan(): Promise<ScreenshotPlan> {
    const file = path.join(helpDir, 'screenshots.ts')
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist`)
    return (await import(file)).default
}

const files = planFiles(await loadPlan(), topic)

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
                expect(fs.existsSync(out)).toBe(true)
            })
        }
    })
}
