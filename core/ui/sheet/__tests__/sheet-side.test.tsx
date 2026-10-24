// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { useWindowSizeStore } from '@tinycld/core/lib/stores/window-size-store'
import { Menu } from '@tinycld/core/ui/menu'
import { OverlayHost, OverlayProvider } from '@tinycld/core/ui/overlay'
import { Sheet, type SheetSide } from '@tinycld/core/ui/sheet'
import * as reanimated from 'react-native-reanimated'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Only the test stub (tests/react-native-reanimated-stub.cjs) exports the log.
const { sharedValueLog } = reanimated as unknown as { sharedValueLog: { history: number[] }[] }

// The reanimated stub records every shared value with the values it held.
// The sheet's translateY is the one that starts off-screen (+-1000) and is
// later sprung to 0 on open; the last off-screen value it held before settling at 0 is
// where the slide-in really starts (a re-seed in the same commit supersedes an
// earlier spring, which the stub applies instantly but a device never paints).
function slideInStart() {
    const sheetTranslate = sharedValueLog.filter(
        sv => Math.abs(sv.history[0]) === 1000 && sv.history.includes(0)
    )
    expect(sheetTranslate).toHaveLength(1)
    const { history } = sheetTranslate[0]
    return history.filter(v => v !== 0).at(-1) as number
}

function Harness({ isOpen, side }: { isOpen: boolean; side: SheetSide }) {
    return (
        <OverlayProvider>
            <OverlayHost name="root" />
            <Sheet isOpen={isOpen} onClose={() => {}} side={side}>
                <Sheet.Body>{null}</Sheet.Body>
            </Sheet>
        </OverlayProvider>
    )
}

beforeEach(() => {
    sharedValueLog.length = 0
})
afterEach(cleanup)

describe('Sheet slide-in start', () => {
    it('starts below the screen for a bottom sheet', () => {
        render(<Harness isOpen side="bottom" />)
        expect(slideInStart()).toBeGreaterThan(0)
    })

    it('starts above the screen when the side flips to top while closed', () => {
        const view = render(<Harness isOpen={false} side="bottom" />)
        view.rerender(<Harness isOpen side="top" />)
        expect(slideInStart()).toBeLessThan(0)
    })
})

describe('Menu as a sheet', () => {
    it('slides down from above when its trigger is in the upper screen', () => {
        useWindowSizeStore.setState({ width: 390, height: 800 })
        render(
            <OverlayProvider>
                <OverlayHost name="root" />
                <Menu anchor={{ x: 20, y: 60 }} isOpen presentation="sheet">
                    <Menu.Item label="One" onSelect={() => {}} />
                </Menu>
            </OverlayProvider>
        )
        expect(slideInStart()).toBeLessThan(0)
    })
})
