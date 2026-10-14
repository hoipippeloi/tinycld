export type DefaultPick =
    | { mode: 'none' }
    | { mode: 'literal'; value: string | number | boolean }
    | { mode: 'today' }
    | { mode: 'today_plus'; days: number }
    | { mode: 'me' }

export type PickMode = DefaultPick['mode']

export function pickToExpression(pick: DefaultPick): unknown | undefined {
    switch (pick.mode) {
        case 'none':
            return undefined
        case 'literal':
            return pick.value
        case 'today':
            return { today: [] }
        case 'today_plus':
            return { addDays: [{ today: [] }, pick.days] }
        case 'me':
            return { me: [] }
    }
}

export function expressionToPick(expr: unknown): DefaultPick {
    if (expr === undefined || expr === null) return { mode: 'none' }
    if (typeof expr === 'string' || typeof expr === 'number' || typeof expr === 'boolean')
        return { mode: 'literal', value: expr }
    if (typeof expr !== 'object' || Array.isArray(expr)) return { mode: 'none' }
    const obj = expr as Record<string, unknown>
    if ('today' in obj) return { mode: 'today' }
    if ('me' in obj) return { mode: 'me' }
    if ('addDays' in obj && Array.isArray(obj.addDays) && typeof obj.addDays[1] === 'number')
        return { mode: 'today_plus', days: obj.addDays[1] }
    return { mode: 'none' }
}

export function picksFor(kind: string): PickMode[] {
    switch (kind) {
        case 'date':
            return ['none', 'literal', 'today', 'today_plus']
        case 'user':
            return ['none', 'me']
        case 'text':
        case 'textarea':
        case 'number':
        case 'toggle':
        case 'select':
        case 'richtext':
        case 'markdown':
            return ['none', 'literal']
        default:
            return ['none']
    }
}

/** Types a typed-in default for a field of this kind; a toggle reads 'on' or 'true' as on. */
export function coerceLiteral(kind: string, value: string): string | number | boolean {
    if (kind === 'number') {
        const n = Number(value)
        return Number.isFinite(n) ? n : value
    }
    if (kind === 'toggle') return value === 'true' || value === 'on'
    return value
}
