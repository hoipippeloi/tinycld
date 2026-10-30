import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fixes to the package template the pinned @tinycld/bootstrap emits, shared by
// every stub scaffolder that starts from it. Each is a line edit, not a JSON or
// AST round-trip: re-serialising would undo the template's formatting and fail
// biome on the stub. Drop each once the pinned bootstrap stops needing it.

/**
 * The pinned bootstrap still emits `'../app/vitest.config'` from before the
 * shell was renamed to tinycld/. Left alone the stub can't resolve its config
 * and `tinycld-pkg check --all` fails on a stale template.
 */
export function patchVitestConfig(stubDir: string): void {
    const path = join(stubDir, 'vitest.config.ts')
    if (!existsSync(path)) return
    const contents = readFileSync(path, 'utf8')
    const patched = contents.replace("'../app/vitest.config'", "'../tinycld/vitest.config'")
    if (patched !== contents) writeFileSync(path, patched)
}

/**
 * Drop the template's `compilerOptions.baseUrl`. TypeScript 6 rejects it
 * (TS5101), so the stub's own typecheck fails before it reads a source file.
 * `paths` resolves against the tsconfig's directory without it, as in every
 * real package.
 */
export function patchTsconfig(stubDir: string): void {
    const path = join(stubDir, 'tsconfig.json')
    const contents = readFileSync(path, 'utf8')
    const patched = contents.replace(/^[ \t]*"baseUrl":\s*"[^"]*",?\n/m, '')
    if (patched !== contents) writeFileSync(path, patched)
}
