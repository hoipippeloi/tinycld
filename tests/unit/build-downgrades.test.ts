import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// config/build-downgrades.sh decides whether the entrypoint may adopt a new
// image's baked build: never when it would move any member back.
const SCRIPT = path.resolve(__dirname, '../../config/build-downgrades.sh')

const roots: string[] = []

function buildRoot(members: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'build-'))
    roots.push(root)
    for (const [name, version] of Object.entries(members)) {
        mkdirSync(path.join(root, name))
        writeFileSync(
            path.join(root, name, 'package.json'),
            `${JSON.stringify({ name: `@tinycld/${name}`, version, dependencies: { x: '1.0.0' } }, null, 4)}\n`
        )
    }
    return root
}

function compare(running: string, candidate: string) {
    const result = spawnSync(SCRIPT, [running, candidate], { encoding: 'utf8' })
    return { status: result.status, lines: result.stdout.trim().split('\n').filter(Boolean) }
}

describe('build-downgrades.sh', () => {
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    it('allows an image at least as new as every running member', () => {
        const running = buildRoot({ tinycld: '0.6.4', mail: '0.6.2' })
        const image = buildRoot({ tinycld: '0.6.4', mail: '0.6.3' })
        expect(compare(running, image)).toEqual({ status: 0, lines: [] })
    })

    it('lists each member the image would move back', () => {
        const running = buildRoot({ tinycld: '0.6.4', mail: '0.6.2', drive: '0.4.1' })
        const image = buildRoot({ tinycld: '0.6.3', mail: '0.6.3', drive: '0.4.0' })
        expect(compare(running, image)).toEqual({
            status: 1,
            lines: ['drive 0.4.1 -> 0.4.0', 'tinycld 0.6.4 -> 0.6.3'],
        })
    })

    it('compares version parts as numbers, not text', () => {
        const running = buildRoot({ tinycld: '0.9.0' })
        const image = buildRoot({ tinycld: '0.10.0' })
        expect(compare(running, image).status).toBe(0)
    })

    it('ignores a member only one side carries', () => {
        const running = buildRoot({ tinycld: '0.6.4', boards: '0.2.0' })
        const image = buildRoot({ tinycld: '0.6.4', calc: '0.1.0' })
        expect(compare(running, image).status).toBe(0)
    })

    it('rejects missing build roots', () => {
        const running = buildRoot({ tinycld: '0.6.4' })
        expect(compare(running, path.join(running, 'nope')).status).toBe(2)
    })
})
