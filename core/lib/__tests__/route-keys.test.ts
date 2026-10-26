import { describe, expect, it } from 'vitest'
import { routeKeysFor } from '../route-keys'

const KEYS = [
    './_layout.tsx',
    './index.tsx',
    './+not-found.tsx',
    './a/connect.tsx',
    './a/connect.web.tsx',
    './a/(app)/_layout.tsx',
    './a/(app)/index.tsx',
    './a/(app)/mail/_layout.tsx',
    './a/(app)/mail/index.tsx',
    './a/(app)/mail/[id].tsx',
    './a/(app)/boards/_layout.tsx',
    './a/(app)/boards/[boardSlug]/_layout.tsx',
    './a/(app)/boards/[boardSlug]/index.tsx',
    './a/(app)/settings/[...section].tsx',
    './p/_layout.tsx',
    './p/boards/[token].tsx',
]

describe('routeKeysFor', () => {
    it('matches the root layout and index for /', () => {
        expect(routeKeysFor('/', KEYS)).toEqual(['./_layout.tsx', './index.tsx'])
    })

    it('ignores group segments and includes every layout on the path', () => {
        expect(routeKeysFor('/a/mail', KEYS)).toEqual([
            './_layout.tsx',
            './a/(app)/_layout.tsx',
            './a/(app)/mail/_layout.tsx',
            './a/(app)/mail/index.tsx',
        ])
    })

    it('matches dynamic leaves and dynamic directories', () => {
        expect(routeKeysFor('/a/mail/abc123', KEYS)).toContain('./a/(app)/mail/[id].tsx')
        expect(routeKeysFor('/a/mail/abc123', KEYS)).not.toContain('./a/(app)/mail/index.tsx')
        expect(routeKeysFor('/a/boards/team-x', KEYS)).toEqual([
            './_layout.tsx',
            './a/(app)/_layout.tsx',
            './a/(app)/boards/_layout.tsx',
            './a/(app)/boards/[boardSlug]/_layout.tsx',
            './a/(app)/boards/[boardSlug]/index.tsx',
        ])
    })

    it('matches a catch-all for any depth below its directory', () => {
        expect(routeKeysFor('/a/settings/team/members', KEYS)).toContain(
            './a/(app)/settings/[...section].tsx'
        )
    })

    it('matches platform-specific files and drops the query string', () => {
        // The (app) group layout is a spare match: groups are invisible in the
        // URL, so the matcher cannot tell connect.tsx sits outside the group.
        expect(routeKeysFor('/a/connect?server=x', KEYS)).toEqual([
            './_layout.tsx',
            './a/connect.tsx',
            './a/connect.web.tsx',
            './a/(app)/_layout.tsx',
        ])
    })

    it('leaves unrelated trees alone', () => {
        const keys = routeKeysFor('/p/boards/tok', KEYS)
        expect(keys).toEqual(['./_layout.tsx', './p/_layout.tsx', './p/boards/[token].tsx'])
    })
})
