import { AccessibilityInfo, type HostInstance, Platform } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveFocus } from '../move-focus'

const realOS = Platform.OS

afterEach(() => {
    Object.assign(Platform, { OS: realOS })
    vi.restoreAllMocks()
})

function target() {
    const focus = vi.fn()
    return { focus, el: { focus } as unknown as HostInstance }
}

describe('moveFocus', () => {
    it('gives DOM focus on web', () => {
        Object.assign(Platform, { OS: 'web' })
        const send = vi.spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
        const { focus, el } = target()
        moveFocus(el)
        expect(focus).toHaveBeenCalledOnce()
        expect(send).not.toHaveBeenCalled()
    })

    it.each(['ios', 'android'])('moves the screen reader cursor on %s', os => {
        Object.assign(Platform, { OS: os })
        const send = vi.spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
        const { focus, el } = target()
        moveFocus(el)
        expect(send).toHaveBeenCalledWith(el, 'focus')
        expect(focus).not.toHaveBeenCalled()
    })
})
