import type { FieldWidth } from '@tinycld/core/lib/forms/definition'

/** Below this container width, quarter becomes half and half and third become full. */
export const NARROW_BELOW = 640

export function effectiveWidth(width: FieldWidth, containerWidth: number): FieldWidth {
    if (containerWidth === 0 || containerWidth >= NARROW_BELOW) return width
    if (width === 'quarter') return 'half'
    return 'full'
}

const CLASSES: Record<FieldWidth, string> = {
    full: 'basis-full',
    half: 'basis-1/2',
    third: 'basis-1/3',
    quarter: 'basis-1/4',
}

export function widthClass(width: FieldWidth): string {
    return CLASSES[width]
}
