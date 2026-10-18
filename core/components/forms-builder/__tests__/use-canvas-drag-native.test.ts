import { describe, expect, it, vi } from 'vitest'

// The handle's hold before a drag is picked per platform: this file is native.
vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (map: { native?: unknown }) => map.native },
}))

describe('the canvas drag handle on native', () => {
    it('waits for a 250 ms hold, so a swipe on a handle still scrolls', async () => {
        const { HANDLE_LONG_PRESS_MS } = await import('../use-canvas-drag')
        expect(HANDLE_LONG_PRESS_MS).toBe(250)
    })
})
