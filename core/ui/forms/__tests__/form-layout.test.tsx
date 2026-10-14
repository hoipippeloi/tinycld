// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FieldCell } from '../FieldCell'
import { FormLayout } from '../FormLayout'

afterEach(cleanup)

function cellOf(container: HTMLElement) {
    const cell = container.querySelector('[testID="form-field-sev"]')
    if (!cell) throw new Error('no form-field-sev cell rendered')
    return cell
}

describe('FieldCell', () => {
    it('renders the label, a required marker and the error', () => {
        const { container, getByText } = render(
            <FormLayout>
                <FieldCell
                    fieldKey="sev"
                    label="Severity"
                    required
                    width="third"
                    containerWidth={1000}
                    error="Severity is required"
                >
                    <></>
                </FieldCell>
            </FormLayout>
        )
        expect(getByText('Severity')).toBeTruthy()
        expect(getByText('*')).toBeTruthy()
        expect(getByText('Severity is required')).toBeTruthy()
        expect(cellOf(container).getAttribute('class')).toContain('basis-1/3')
    })
    it('collapses the width class in a narrow container', () => {
        const { container } = render(
            <FieldCell
                fieldKey="sev"
                label="Severity"
                required={false}
                width="quarter"
                containerWidth={400}
            >
                <></>
            </FieldCell>
        )
        expect(cellOf(container).getAttribute('class')).toContain('basis-1/2')
    })
})
