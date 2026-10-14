import { ACTION_LABELS } from '@tinycld/core/lib/forms/builder'
import type { FormDefinition } from '@tinycld/core/lib/forms/definition'
import type { EvalContext, FormValues } from '@tinycld/core/lib/forms/logic'
import { FormRenderer } from '@tinycld/core/ui/forms'
import type { ReactNode } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Text, View } from 'react-native'
import { useCanvasDefinition } from './Canvas'
import type { DraftRule } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface AffectedFieldsProps {
    editor: Editor
    ruleIndex: number
    isVisible: boolean
}

// The design layout evaluates no rules and applies no defaults, so the context is never read.
const DESIGN_CONTEXT: EvalContext = { today: '1970-01-01', userId: '' }

function RuleBadge({ text }: { text: string }) {
    return <Text className="text-xs text-primary bg-muted rounded px-1.5 ml-2">{text}</Text>
}

/** "when" on each field the rule reads; the action's verb on each field it changes, or every field of a page it changes. */
export function badgesFor(rule: DraftRule, definition: FormDefinition): Record<string, ReactNode> {
    const labels = new Map<string, string[]>()
    const add = (key: string, label: string) => {
        const list = labels.get(key) ?? []
        if (!list.includes(label)) labels.set(key, [...list, label])
    }
    for (const condition of rule.when) add(condition.field, 'when')
    for (const action of rule.actions) {
        const label = ACTION_LABELS[action.action]
        if ('page' in action && action.page) {
            const page = action.page
            for (const field of definition.fields.filter(f => f.page === page))
                add(field.key, label)
        } else if ('field' in action && action.field) add(action.field, label)
    }
    const entries = [...labels].map(([key, list]) => [
        key,
        <RuleBadge key={key} text={list.join(' · ')} />,
    ])
    return Object.fromEntries(entries)
}

interface PaneProps {
    editor: Editor
    host: NonNullable<Editor['host']>
    ruleIndex: number
}

function AffectedPane({ editor, host, ruleIndex }: PaneProps) {
    const { definition } = useCanvasDefinition(editor.form.control)
    const rule = useWatch({ control: editor.form.control, name: `rules.${ruleIndex}` })
    // FormRenderer's inputs need a form instance; in design mode its values never matter.
    const inert = useForm<FormValues>({ defaultValues: {} })
    if (!definition || !rule) return null
    // A picture of the rule beside its editor: the controls it shows are not for use.
    return (
        <View className="w-[360px]" pointerEvents="none" aria-hidden testID="form-rule-affected">
            <Text className="text-sm font-semibold text-foreground mb-2">
                Fields this rule uses
            </Text>
            <FormRenderer
                host={host}
                ui={null}
                definition={definition}
                layout="design"
                form={inert}
                context={DESIGN_CONTEXT}
                design={{ badges: badgesFor(rule, definition) }}
            />
        </View>
    )
}

/** The form, read-only, with the selected rule's inputs and effects marked. */
export function AffectedFields({ editor, ruleIndex, isVisible }: AffectedFieldsProps) {
    if (!isVisible || !editor.host) return null
    return <AffectedPane editor={editor} host={editor.host} ruleIndex={ruleIndex} />
}
