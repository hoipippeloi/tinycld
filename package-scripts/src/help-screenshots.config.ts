import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

const member = process.env.HELP_SCREENSHOTS_MEMBER
if (!member)
    throw new Error(
        'HELP_SCREENSHOTS_MEMBER is not set; run through `tinycld-pkg help:screenshots`'
    )

// The member's own config carries the webServer, ports and browser setup; only
// the test dir and match change, so screenshots run against the same server as e2e.
const memberConfigFile = path.join(member, 'playwright.config.ts')
if (!fs.existsSync(memberConfigFile))
    throw new Error(
        `${memberConfigFile} does not exist; help:screenshots needs the member's Playwright config for its webServer and ports`
    )
const memberConfig = (await import(memberConfigFile)).default

export default defineConfig({
    ...memberConfig,
    testDir: import.meta.dirname,
    testMatch: 'help-screenshots.spec.ts',
    // One worker and no retries are not a flake workaround: the command writes
    // files in a fixed order, and a retry would re-run `setup` against changed state.
    fullyParallel: false,
    workers: 1,
    retries: 0,
})
