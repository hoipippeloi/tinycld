import * as fs from 'node:fs'
import * as path from 'node:path'
import { type CurrentPackage, isAppShellName } from './discovery'

export type Verb = 'typecheck' | 'test' | 'test:e2e' | 'check'

function readJson(file: string): { name?: string; workspaces?: string[] } | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

// The root `workspaces` list names every member, nested ones (core lives at
// tinycld/core) included. The active app checkout can be a worktree outside
// that list, so it and its nested core are added explicitly.
function memberDirs(workspaceRoot: string, appDir: string): string[] {
    const workspaces = readJson(path.join(workspaceRoot, 'package.json'))?.workspaces ?? []
    const dirs = new Set(workspaces.map(member => path.join(workspaceRoot, member)))
    dirs.add(appDir)
    dirs.add(path.join(appDir, 'core'))
    return [...dirs]
}

// Build the "all" target list for a verb: features (+ app shell and core for
// non-e2e). Read the member dirs directly to avoid importing app code.
export function allTargets(workspaceRoot: string, appDir: string, verb: Verb): CurrentPackage[] {
    const targets: CurrentPackage[] = []
    for (const dir of memberDirs(workspaceRoot, appDir)) {
        const pj = readJson(path.join(dir, 'package.json'))
        if (!pj?.name) continue
        const hasManifest =
            fs.existsSync(path.join(dir, 'manifest.ts')) ||
            fs.existsSync(path.join(dir, 'manifest.js'))
        if (hasManifest) targets.push({ dir, name: pj.name, kind: 'feature' })
        else if (dir === appDir && isAppShellName(pj.name) && verb !== 'test:e2e')
            targets.push({ dir, name: pj.name, kind: 'app' })
        // core: shared lib, no manifest, no e2e — but typecheck/test/check it.
        // Only the active checkout's core, never a second worktree's.
        else if (
            pj.name === '@tinycld/core' &&
            dir === path.join(appDir, 'core') &&
            verb !== 'test:e2e'
        )
            targets.push({ dir, name: '@tinycld/core', kind: 'core' })
    }
    // Skip targets that have nothing to run for the verb.
    return targets.filter(t => {
        if (verb === 'test:e2e') return fs.existsSync(path.join(t.dir, 'playwright.config.ts'))
        if (verb === 'test') return fs.existsSync(path.join(t.dir, 'vitest.config.ts'))
        return fs.existsSync(path.join(t.dir, 'tsconfig.json'))
    })
}
