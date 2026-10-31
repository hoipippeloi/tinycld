import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every name in the theme color type must be a --color-* in global.css.
// The type alone cannot catch a missing one: `bg-danger-soft` and
// useThemeColor('danger-soft') compile, then render no color on web and
// native. That is how the error box in FormErrorSummary lost its tint.

// Names in the type that nothing uses yet and global.css does not define.
// This list may only get shorter: define a name before you use it, then
// remove it here.
const NOT_DEFINED_YET = new Set([
    'surface-foreground',
    'surface-hover',
    'overlay',
    'segment',
    'segment-foreground',
    'separator',
    'focus',
    'default',
    'default-foreground',
    'background-secondary',
    'background-tertiary',
    'background-inverse',
    'default-hover',
    'accent-hover',
    'success-hover',
    'warning-hover',
    'danger-hover',
    'field-hover',
    'field-focus',
    'field-border-hover',
    'field-border-focus',
    'surface-tertiary',
    'on-surface',
    'on-surface-foreground',
    'on-surface-hover',
    'on-surface-focus',
    'on-surface-secondary',
    'on-surface-secondary-foreground',
    'on-surface-secondary-hover',
    'on-surface-secondary-focus',
    'on-surface-tertiary',
    'on-surface-tertiary-foreground',
    'on-surface-tertiary-hover',
    'on-surface-tertiary-focus',
    'separator-secondary',
    'separator-tertiary',
    'border-secondary',
    'border-tertiary',
])

const repoRoot = join(import.meta.dirname, '..', '..', '..')

function typeColorNames(): string[] {
    const source = readFileSync(join(repoRoot, 'core', 'lib', 'use-app-theme.ts'), 'utf8')
    const start = source.indexOf('type BuiltInThemeColor')
    const end = source.indexOf('export type AppThemeColor')
    return [...source.slice(start, end).matchAll(/\|\s*'([a-z0-9-]+)'/g)].map(m => m[1])
}

const css = readFileSync(join(repoRoot, 'global.css'), 'utf8')

function colorNames(text: string): Set<string> {
    return new Set([...text.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map(m => m[1]))
}

// One block of global.css, from its opening line to its closing brace.
function cssBlock(marker: string): string {
    const start = css.indexOf(marker)
    return css.slice(start, css.indexOf('\n}', start))
}

describe('theme colors', () => {
    it('defines every color name the type offers, except the listed ones', () => {
        const defined = colorNames(css)
        const missing = typeColorNames().filter(n => !defined.has(n) && !NOT_DEFINED_YET.has(n))
        expect(missing).toEqual([])
    })

    it('keeps the not-defined list honest: a defined name leaves it', () => {
        const defined = colorNames(css)
        expect([...NOT_DEFINED_YET].filter(n => defined.has(n))).toEqual([])
    })

    // A nested .light/.dark scope re-derives each --color-*, or the scope
    // keeps the root theme's resolved value (see global.css).
    it('re-derives every @theme color in the .light/.dark scopes', () => {
        const scoped = colorNames(cssBlock('.light,\n.dark {'))
        const themed = colorNames(cssBlock('@theme static {'))
        expect([...themed].filter(n => !scoped.has(n))).toEqual([])
    })
})
