/** A computed value as text: fixed decimals, no grouping. Anything but a finite number is ''. */
export function formatComputed(value: unknown, decimals: number): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return ''
    return value.toFixed(decimals)
}
