import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDataOnlyEventsModule, checkNotifyEventsModule } from '../gen-notify'

const tmpDirs: string[] = []
afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makePkg(exportsMap: Record<string, string>, files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-notify-'))
    tmpDirs.push(dir)
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: '@acme/gizmos', exports: exportsMap })
    )
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content)
    }
    return dir
}

const DATA_ONLY = `import type { PackageNotifyEvents } from '@tinycld/core/lib/notify/types'
import { GIZMO_LABEL } from './labels'

declare module '@tinycld/core/lib/notify/events' {
    interface NotificationEvents {
        'gizmos.ready': { id: string }
    }
}

const events: PackageNotifyEvents = {
    'gizmos.ready': { channels: ['in-app'], variant: 'info' },
}
export default events
`

describe('assertDataOnlyEventsModule', () => {
    it('accepts type-only core imports and runtime imports from elsewhere', () => {
        expect(() =>
            assertDataOnlyEventsModule(DATA_ONLY, '@acme/gizmos', 'notify-events')
        ).not.toThrow()
    })

    it('refuses a runtime import from core, naming the package and subpath', () => {
        const source = `import { notify } from '@tinycld/core/lib/notify'\n${DATA_ONLY}`
        expect(() => assertDataOnlyEventsModule(source, '@acme/gizmos', 'notify-events')).toThrow(
            /@acme\/gizmos.*'notify-events'.*@tinycld\/core/
        )
    })

    it('refuses a multi-line runtime import from core', () => {
        const source = `import {\n    notify,\n    log,\n} from "@tinycld/core/lib/notify"\n${DATA_ONLY}`
        expect(() => assertDataOnlyEventsModule(source, '@acme/gizmos', 'notify-events')).toThrow(
            /runtime import/
        )
    })

    it('refuses a side-effect import and a runtime re-export from core', () => {
        const sideEffect = `import '@tinycld/core/lib/notify'\n${DATA_ONLY}`
        const reExport = `${DATA_ONLY}export { notify } from '@tinycld/core/lib/notify'\n`
        expect(() =>
            assertDataOnlyEventsModule(sideEffect, '@acme/gizmos', 'notify-events')
        ).toThrow(/runtime import/)
        expect(() => assertDataOnlyEventsModule(reExport, '@acme/gizmos', 'notify-events')).toThrow(
            /runtime import/
        )
    })

    it('refuses a runtime import of the generated config', () => {
        const source = `import { tinycldConfig } from '@tinycld/app-generated/tinycld-config'\n${DATA_ONLY}`
        expect(() => assertDataOnlyEventsModule(source, '@acme/gizmos', 'notify-events')).toThrow(
            /runtime import/
        )
    })
})

describe('checkNotifyEventsModule', () => {
    it('resolves the subpath through the exports map and checks the module', () => {
        const dir = makePkg(
            { './notify-events': './tinycld/gizmos/notify-events.ts' },
            { 'tinycld/gizmos/notify-events.ts': DATA_ONLY }
        )
        expect(() => checkNotifyEventsModule(dir, '@acme/gizmos', 'notify-events')).not.toThrow()
    })

    it('throws naming the package and subpath when the exports map lacks it', () => {
        const dir = makePkg({}, {})
        expect(() => checkNotifyEventsModule(dir, '@acme/gizmos', 'notify-events')).toThrow(
            /@acme\/gizmos.*no '\.\/notify-events' entry/
        )
    })

    it('throws when the exports entry is a conditional-exports object', () => {
        const dir = makePkg({}, {})
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                name: '@acme/gizmos',
                exports: { './notify-events': { import: './tinycld/gizmos/notify-events.ts' } },
            })
        )
        expect(() => checkNotifyEventsModule(dir, '@acme/gizmos', 'notify-events')).toThrow(
            /'\.\/notify-events'.*not a plain string/
        )
    })

    it('throws when the exported file does not exist', () => {
        const dir = makePkg({ './notify-events': './tinycld/gizmos/notify-events.ts' }, {})
        expect(() => checkNotifyEventsModule(dir, '@acme/gizmos', 'notify-events')).toThrow(
            /@acme\/gizmos.*does not exist/
        )
    })

    it('throws when the module imports core at runtime', () => {
        const dir = makePkg(
            { './notify-events': './tinycld/gizmos/notify-events.ts' },
            {
                'tinycld/gizmos/notify-events.ts': `import { notify } from '@tinycld/core/lib/notify'\n${DATA_ONLY}`,
            }
        )
        expect(() => checkNotifyEventsModule(dir, '@acme/gizmos', 'notify-events')).toThrow(
            /runtime import/
        )
    })
})
