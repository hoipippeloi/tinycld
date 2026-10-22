import type { FormulaOperands } from '@tinycld/core/lib/forms/builder'
import { Controller, NumberInput } from '@tinycld/core/ui/form'
import { FormulaEditor } from './FormulaEditor'
import { InlineError } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export type ExpressionPath =
    | `fields.${number}.expression`
    | `fields.${number}.columns.${number}.expression`
export type DecimalsPath =
    | `fields.${number}.decimals`
    | `fields.${number}.columns.${number}.decimals`

export interface FormulaSettingsProps {
    editor: Editor
    name: ExpressionPath
    decimalsName: DecimalsPath
    operands: FormulaOperands
    valueNoun: string
    testID: string
}

/** A calculated value's or a calculated column's formula and decimal places, in the draft. */
export function FormulaSettings({
    editor,
    name,
    decimalsName,
    operands,
    valueNoun,
    testID,
}: FormulaSettingsProps) {
    const { control } = editor.form
    // Checked as it is built, so a cycle or a missing field shows at once.
    const check = () => {
        void editor.form.trigger(name)
    }
    return (
        <>
            <Controller
                control={control}
                name={name}
                render={({ field }) => (
                    <FormulaEditor
                        value={field.value}
                        onChange={expr => {
                            field.onChange(expr)
                            check()
                        }}
                        operands={operands}
                        valueNoun={valueNoun}
                        testID={testID}
                    />
                )}
            />
            <InlineError control={control} name={name} testID={`${testID}-error`} />
            <NumberInput
                control={control}
                name={decimalsName}
                label="Decimal places"
                min={0}
                max={6}
            />
        </>
    )
}
