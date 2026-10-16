// @vitest-environment happy-dom

import { cleanup, render as renderBare } from '@testing-library/react'
import { ValueInput } from '@tinycld/core/components/rules/ValueInput'
import { OverlayProvider } from '@tinycld/core/ui/overlay'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

describe('ValueInput', () => {
    afterEach(cleanup)

    it('labels the select trigger for a screen reader', () => {
        const { container } = render(
            <ValueInput
                field={{ key: 'status', label: 'Status', type: 'select', options: ['open'] }}
                op="eq"
                value="open"
                onChange={() => {}}
            />
        )
        expect(container.querySelector('[accessibilitylabel="Condition value"]')).not.toBeNull()
    })
})
