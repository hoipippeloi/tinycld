import * as fs from 'node:fs'
import * as path from 'node:path'

// The events module is imported by the generated tinycld.config.ts, and the
// notify dispatcher composes its registry from tinycldConfig at module load.
// A runtime import that reaches the dispatcher (anything under @tinycld/core,
// or the generated config itself) would make tinycldConfig read itself during
// its own initialisation. `import type` is erased and safe. The quote class
// stops a match from running past one import's specifier into the next line,
// since the codebase writes no semicolons.
const RUNTIME_CORE_IMPORT =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s*)?['"]@tinycld\/(?:core|app-generated)\b/m

export function assertDataOnlyEventsModule(
    source: string,
    packageName: string,
    subpath: string
): void {
    const match = source.match(RUNTIME_CORE_IMPORT)
    if (!match) return
    throw new Error(
        `[generate] ${packageName}: notifications.events module '${subpath}' has a runtime import from @tinycld/core or @tinycld/app-generated (${JSON.stringify(match[0].trim())}). It must be pure data; use \`import type\` for core types.`
    )
}

// Resolve the events subpath through the package's exports map, the way
// loadAutomationDefs does, then check the module's source. It is read as text
// and never imported: importing it here would not reveal the cycle, which only
// exists inside the bundle.
export function checkNotifyEventsModule(
    packageDir: string,
    packageName: string,
    subpath: string
): void {
    const pkgJsonPath = path.join(packageDir, 'package.json')
    const exportsMap = (JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).exports ?? {}) as Record<
        string,
        string | Record<string, unknown>
    >
    const rel = exportsMap[`./${subpath}`]
    if (!rel) {
        throw new Error(
            `[generate] ${packageName}: manifest declares notifications.events '${subpath}' but package.json exports has no './${subpath}' entry`
        )
    }
    if (typeof rel !== 'string') {
        throw new Error(
            `[generate] ${packageName}: exports entry './${subpath}' is not a plain string (conditional exports are unsupported here)`
        )
    }
    const file = path.join(packageDir, rel)
    if (!fs.existsSync(file)) {
        throw new Error(
            `[generate] ${packageName}: notifications.events '${subpath}' resolves to '${rel}', which does not exist`
        )
    }
    assertDataOnlyEventsModule(fs.readFileSync(file, 'utf8'), packageName, subpath)
}
