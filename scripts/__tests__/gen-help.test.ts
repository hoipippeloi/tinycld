import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    buildHelpSource,
    collectHelpImages,
    type HelpGroupInput,
    helpImageRefs,
    parseFrontmatter,
    validateHelpImages,
} from '../gen-help'

const DOC = `---
title: Composing a message
summary: Write and send mail
tags: [compose, draft]
order: 10
---

## To compose

Click **Compose**.
`

describe('parseFrontmatter', () => {
    it('extracts title/summary/tags/order and body', () => {
        const r = parseFrontmatter(DOC)
        expect(r.title).toBe('Composing a message')
        expect(r.summary).toBe('Write and send mail')
        expect(r.tags).toEqual(['compose', 'draft'])
        expect(r.order).toBe(10)
        expect(r.body.trim().startsWith('## To compose')).toBe(true)
    })
})

describe('buildHelpSource', () => {
    it('emits a HelpGroup[] with id = pkg:topic, sorted by order', () => {
        const src = buildHelpSource(
            [
                {
                    packageName: '@tinycld/gizmos',
                    pkgSlug: 'gizmos',
                    images: [],
                    topics: [
                        {
                            topicId: 'b',
                            frontmatter: parseFrontmatter(
                                '---\ntitle: B\nsummary: s\norder: 2\n---\nx'
                            ),
                        },
                        {
                            topicId: 'a',
                            frontmatter: parseFrontmatter(
                                '---\ntitle: A\nsummary: s\norder: 1\n---\nx'
                            ),
                        },
                    ],
                },
            ],
            '/ws/tinycld/lib/generated'
        )
        expect(src).toContain('export const packageHelp')
        // order 1 (a) should appear before order 2 (b)
        expect(src.indexOf('"gizmos:a"')).toBeLessThan(src.indexOf('"gizmos:b"'))
    })
})

function group(body: string, imageKeys: string[]): HelpGroupInput {
    return {
        packageName: '@acme/gizmos',
        pkgSlug: 'gizmos',
        images: imageKeys.map(key => ({ key, file: `/ws/gizmos/help/${key}` })),
        topics: [
            {
                topicId: 'intro',
                frontmatter: parseFrontmatter(`---\ntitle: Intro\nsummary: s\n---\n${body}`),
            },
        ],
    }
}

describe('helpImageRefs', () => {
    it('lists relative refs only, ignoring links and absolute images', () => {
        const body = [
            '![a](images/a.png)',
            '![b](./images/b.png "title")',
            '![c](https://x.test/c.png)',
            '[link](images/d.png)',
        ].join('\n')
        expect(helpImageRefs(body)).toEqual(['images/a.png', './images/b.png'])
    })
})

describe('validateHelpImages', () => {
    it('accepts a ref that matches a shipped file', () => {
        expect(() =>
            validateHelpImages(group('![a](images/a.png)', ['images/a.png']))
        ).not.toThrow()
    })

    it('throws naming the topic and the missing file', () => {
        expect(() => validateHelpImages(group('![a](images/nope.png)', []))).toThrow(
            /gizmos:intro.*images\/nope\.png/
        )
    })

    it('throws on parent traversal', () => {
        expect(() => validateHelpImages(group('![a](../secret.png)', []))).toThrow(/\.\./)
    })
})

describe('collectHelpImages', () => {
    it('walks nested dirs, keeps only image extensions, uses posix keys', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-images-'))
        fs.mkdirSync(path.join(dir, 'images'))
        fs.writeFileSync(path.join(dir, 'intro.md'), '---\ntitle: T\nsummary: s\n---\n')
        fs.writeFileSync(path.join(dir, 'images', 'a.png'), '')
        fs.writeFileSync(path.join(dir, 'images', 'a.dark.png'), '')
        fs.writeFileSync(path.join(dir, 'images', 'notes.txt'), '')
        expect(collectHelpImages(dir).map(i => i.key)).toEqual([
            'images/a.dark.png',
            'images/a.png',
        ])
    })
})

describe('buildHelpSource images', () => {
    it('emits a require per image, relative to the generated dir', () => {
        const src = buildHelpSource([group('x', ['images/a.png'])], '/ws/tinycld/lib/generated')
        expect(src).toContain(
            'export const helpImages: Record<string, number | string | { uri: string }> = {'
        )
        expect(src).toContain(
            '"gizmos/images/a.png": require("../../../gizmos/help/images/a.png"),'
        )
    })

    it('emits an empty map when no package ships images', () => {
        const src = buildHelpSource([], '/ws/tinycld/lib/generated')
        expect(src).toContain(
            'export const helpImages: Record<string, number | string | { uri: string }> = {\n}'
        )
    })
})
