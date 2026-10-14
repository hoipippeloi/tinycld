import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allTargets } from '../src/targets'

function writePkg(dir: string, name: string, files: string[] = []) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))
    for (const file of ['tsconfig.json', ...files]) fs.writeFileSync(path.join(dir, file), '')
}

// The real layout: core nested inside the app checkout, listed in the root
// `workspaces` as app/core. A second app worktree sits beside the active one.
function makeWs(): string {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tcld-targets-')))
    fs.writeFileSync(
        path.join(ws, 'package.json'),
        JSON.stringify({ workspaces: ['app', 'app/core', 'doodads', 'absent'] })
    )
    writePkg(path.join(ws, 'app'), 'tinycld', ['vitest.config.ts'])
    writePkg(path.join(ws, 'app', 'core'), '@tinycld/core', ['vitest.config.ts'])
    writePkg(path.join(ws, 'doodads'), '@tinycld/doodads', [
        'manifest.ts',
        'vitest.config.ts',
        'playwright.config.ts',
    ])
    writePkg(path.join(ws, 'app-wt'), 'tinycld')
    writePkg(path.join(ws, 'app-wt', 'core'), '@tinycld/core')
    return ws
}

function names(ws: string, appDir: string, verb: Parameters<typeof allTargets>[2]) {
    return allTargets(ws, appDir, verb)
        .map(t => `${t.kind}:${path.relative(ws, t.dir)}`)
        .sort()
}

describe('allTargets', () => {
    let ws: string
    beforeEach(() => {
        ws = makeWs()
    })
    afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

    it('includes the core nested in the app checkout', () => {
        expect(names(ws, path.join(ws, 'app'), 'check')).toEqual([
            'app:app',
            'core:app/core',
            'feature:doodads',
        ])
    })

    it('targets only features with a playwright config for e2e', () => {
        expect(names(ws, path.join(ws, 'app'), 'test:e2e')).toEqual(['feature:doodads'])
    })

    it('targets the active worktree and its core, not the listed checkout', () => {
        expect(names(ws, path.join(ws, 'app-wt'), 'typecheck')).toEqual([
            'app:app-wt',
            'core:app-wt/core',
            'feature:doodads',
        ])
    })
})
