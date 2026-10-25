import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    buildCheckCommands,
    buildHelpScreenshotsCommand,
    buildLintCommand,
    buildTestCommand,
    buildTypecheckCommand,
} from '../src/runners'

const appDir = '/ws/app'
const featurePkg = { dir: '/ws/doodads', name: '@tinycld/doodads', kind: 'feature' as const }
const appPkg = { dir: '/ws/app', name: 'app', kind: 'app' as const }

describe('buildTypecheckCommand', () => {
    it('runs tsc against the package tsconfig', () => {
        const cmd = buildTypecheckCommand(featurePkg, appDir)
        expect(cmd.bin).toBe('tsc')
        expect(cmd.args).toEqual(['--noEmit', '-p', path.join('/ws/doodads', 'tsconfig.json')])
        expect(cmd.cwd).toBe('/ws/doodads')
    })
})

describe('buildTestCommand', () => {
    it('runs vitest with the package vitest.config', () => {
        const cmd = buildTestCommand(featurePkg, appDir)
        expect(cmd.bin).toBe('vitest')
        expect(cmd.args).toEqual(['run', '--config', path.join('/ws/doodads', 'vitest.config.ts')])
    })
    it('for the app shell, uses the app vitest.config', () => {
        const cmd = buildTestCommand(appPkg, appDir)
        expect(cmd.args).toContain(path.join('/ws/app', 'vitest.config.ts'))
    })
})

describe('buildLintCommand', () => {
    it('runs biome from the app dir, scoped to the package dir', () => {
        // biome MUST run from app/ so it picks up app/biome.json — the
        // single ecosystem config. Running from pkg.dir falls back to
        // biome's defaults and produces different (stricter) output.
        const cmd = buildLintCommand(featurePkg, appDir)
        expect(cmd.bin).toBe('biome')
        expect(cmd.args).toEqual(['check', '/ws/doodads'])
        expect(cmd.cwd).toBe(appDir)
    })
})

describe('buildCheckCommands', () => {
    it('is lint then typecheck then test (NOT e2e)', () => {
        const cmds = buildCheckCommands(featurePkg, appDir, true)
        expect(cmds.map(c => c.bin)).toEqual(['biome', 'tsc', 'vitest'])
    })
    it('skips the unit tests of a member without a vitest.config.ts', () => {
        const cmds = buildCheckCommands(featurePkg, appDir, false)
        expect(cmds.map(c => c.bin)).toEqual(['biome', 'tsc'])
    })
})

describe('buildHelpScreenshotsCommand', () => {
    it('runs playwright with the shipped config and passes the member through env', () => {
        const cmd = buildHelpScreenshotsCommand(featurePkg, appDir, { topic: 'alpha-topic' })
        expect(cmd.bin).toBe('playwright')
        expect(cmd.args.slice(0, 2)).toEqual(['test', '--config'])
        expect(cmd.args[2]).toMatch(/help-screenshots\.config\.ts$/)
        expect(cmd.args).not.toContain('--topic')
        expect(cmd.env).toEqual({
            HELP_SCREENSHOTS_MEMBER: featurePkg.dir,
            HELP_SCREENSHOTS_TOPIC: 'alpha-topic',
        })
    })
    it('omits the topic env when no topic is given', () => {
        const cmd = buildHelpScreenshotsCommand(featurePkg, appDir, {})
        expect(cmd.env).toEqual({ HELP_SCREENSHOTS_MEMBER: featurePkg.dir })
    })
})
