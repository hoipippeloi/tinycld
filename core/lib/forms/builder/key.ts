const MAX_KEY = 40

/** A field key from its label: lowercase ASCII, underscores, starts with a letter. Runs only when a field is created. */
export function keyFromLabel(label: string): string {
    const ascii = label
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    if (ascii === '') return 'field'
    const prefixed = /^[a-z]/.test(ascii) ? ascii : `f_${ascii}`
    return prefixed.slice(0, MAX_KEY).replace(/_+$/, '')
}

export function uniqueKey(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
        const suffix = `_${n}`
        const candidate = `${base.slice(0, MAX_KEY - suffix.length)}${suffix}`
        if (!taken.has(candidate)) return candidate
    }
}
