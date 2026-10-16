// @vitest-environment happy-dom

import { layerToDismiss } from '@tinycld/core/ui/overlay/layer-stack'
import { describe, expect, it } from 'vitest'

function node(parent?: Node): Node {
    const n = document.createElement('div')
    parent?.appendChild(n)
    return n
}

function layer(overrides: Partial<Parameters<typeof layerToDismiss>[0][number]> = {}) {
    return {
        id: 1,
        nodes: () => [],
        onDismiss: () => {},
        dismissOnOutside: true,
        dismissOnEscape: true,
        isModal: false,
        ...overrides,
    }
}

describe('layerToDismiss', () => {
    it('a press inside the layer does not dismiss it', () => {
        const surface = node()
        const target = node(surface)
        expect(layerToDismiss([layer({ nodes: () => [surface] })], target)).toBeNull()
    })

    it('a press outside dismisses the top layer', () => {
        const top = layer()
        expect(layerToDismiss([top], node())).toBe(top)
    })

    it('a press outside the region the layer names is not its business', () => {
        const region = node()
        const top = layer({ within: () => region })
        expect(layerToDismiss([top], node())).toBeNull()
    })

    it('a press inside the region but outside the surface dismisses', () => {
        const region = node()
        const surface = node(region)
        const target = node(region)
        const top = layer({ within: () => region, nodes: () => [surface] })
        expect(layerToDismiss([top], target)).toBe(top)
    })
})
