import type {
    CatalogAction,
    CatalogParam,
    CatalogResponse,
    CatalogTrigger,
} from '@tinycld/core/lib/automation/api'
import {
    appendPlaceholder,
    compatibleActions,
    orderGroupsByUserPreference,
} from '@tinycld/core/lib/automation/condition-helpers'
import type { RuleDraft } from '@tinycld/core/lib/automation/draft'
import { parseRefSafe } from '@tinycld/core/lib/automation/helpers'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useSortedPackages } from '@tinycld/core/lib/use-sorted-packages'
import { Menu } from '@tinycld/core/ui/menu'
import { ArrowDown, ArrowUp, Braces, Plus, Trash2 } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { RuleCard } from './RuleCard'
import { ValueInput } from './ValueInput'

type DraftAction = RuleDraft['actions'][number]

export interface ActionsCardProps {
    triggerRef: string
    /** One per action, in order; `key` is a stable React key that moves with
     * its action on a reorder. */
    actionRows: { key: string; action: DraftAction }[]
    catalog: CatalogResponse
    onAdd: (ref: string) => void
    onMove: (from: number, to: number) => void
    onRemove: (index: number) => void
    onChangeParams: (index: number, params: DraftAction['params']) => void
}

function groupActionsByPackage(actions: CatalogAction[]): Map<string, CatalogAction[]> {
    const groups = new Map<string, CatalogAction[]>()
    for (const action of actions) {
        const list = groups.get(action.pkg) ?? []
        list.push(action)
        groups.set(action.pkg, list)
    }
    return groups
}

/**
 * The label shown for one action in the add-action menu.
 *
 * Packages pick their own action labels, so collisions are normal — drive and
 * mail both call theirs "Move to folder". The group heading above each item
 * says which package it is, but two identically-worded rows a few lines apart
 * are easy to misread, so an ambiguous label carries its package inline. The
 * unambiguous majority stay clean.
 */
function actionOptionLabel(action: CatalogAction, isAmbiguous: boolean): string {
    if (!action.available) return `${action.label} (needs ${action.pkg})`
    return isAmbiguous ? `${action.label} (${action.pkg})` : action.label
}

/** Labels contributed by more than one package, so they need qualifying. */
function ambiguousLabels(actions: CatalogAction[]): Set<string> {
    const seen = new Map<string, string>()
    const ambiguous = new Set<string>()
    for (const action of actions) {
        const owner = seen.get(action.label)
        if (owner === undefined) {
            seen.set(action.label, action.pkg)
        } else if (owner !== action.pkg) {
            ambiguous.add(action.label)
        }
    }
    return ambiguous
}

function AddActionMenu({
    catalog,
    trigger,
    onSelect,
}: {
    catalog: CatalogResponse
    trigger: CatalogTrigger | undefined
    onSelect: (action: CatalogAction) => void
}) {
    const mutedColor = useThemeColor('muted-foreground')
    const options = trigger ? compatibleActions(catalog, trigger) : []
    // Ordered like the trigger menu (and the sidebar): the user's own app
    // order, with core's package-neutral actions leading.
    const orderedSlugs = useSortedPackages().map(p => p.slug)
    const groups = orderGroupsByUserPreference(groupActionsByPackage(options), orderedSlugs)
    const ambiguous = ambiguousLabels(options)

    return (
        <Menu
            trigger={
                <Pressable className="self-start flex-row items-center gap-1 py-1">
                    <Plus size={13} color={mutedColor} />
                    <Text className="text-xs text-muted-foreground">add action</Text>
                </Pressable>
            }
            placement="bottom-start"
        >
            {groups.map(([pkg, actions]) => (
                <Menu.Section key={pkg} label={pkg}>
                    {actions.map(action => (
                        <Menu.Item
                            key={action.ref}
                            testID={`action-option-${action.ref}`}
                            label={actionOptionLabel(action, ambiguous.has(action.label))}
                            isDisabled={!action.available}
                            onSelect={() => onSelect(action)}
                        />
                    ))}
                </Menu.Section>
            ))}
        </Menu>
    )
}

function TemplateFieldMenu({
    trigger,
    onSelectKey,
}: {
    trigger: CatalogTrigger | undefined
    onSelectKey: (key: string) => void
}) {
    const mutedColor = useThemeColor('muted-foreground')
    const fields = trigger?.fields ?? []
    if (fields.length === 0) return null

    return (
        <Menu
            trigger={
                <Pressable className="p-1.5" hitSlop={8}>
                    <Braces size={14} color={mutedColor} />
                </Pressable>
            }
            placement="bottom-start"
        >
            {fields.map(field => (
                <Menu.Item
                    key={field.key}
                    label={field.label}
                    onSelect={() => onSelectKey(field.key)}
                />
            ))}
        </Menu>
    )
}

function ActionParamRow({
    param,
    trigger,
    value,
    onChange,
}: {
    param: CatalogParam
    trigger: CatalogTrigger | undefined
    value: string | number | boolean | undefined
    onChange: (v: string | number | boolean | undefined) => void
}) {
    const isTemplateText = param.template && param.field.type === 'text'
    const textValue = typeof value === 'string' ? value : ''

    return (
        <View className="gap-1">
            <Text className="text-xs text-muted-foreground">{param.label}</Text>
            <View className="flex-row items-center gap-1">
                <ValueInput field={param.field} op="eq" value={value} onChange={onChange} />
                {isTemplateText ? (
                    <TemplateFieldMenu
                        trigger={trigger}
                        onSelectKey={key => onChange(appendPlaceholder(textValue, key))}
                    />
                ) : null}
            </View>
        </View>
    )
}

function ActionEntry({
    index,
    total,
    draftAction,
    catalog,
    trigger,
    onChangeParams,
    onMove,
    onRemove,
}: {
    index: number
    total: number
    draftAction: DraftAction
    catalog: CatalogResponse
    trigger: CatalogTrigger | undefined
    onChangeParams: (params: DraftAction['params']) => void
    onMove: (to: number) => void
    onRemove: () => void
}) {
    const mutedColor = useThemeColor('muted-foreground')
    const action = catalog.actions.find(a => a.ref === draftAction.ref)
    const { pkg, id } = parseRefSafe(draftAction.ref)

    // undefined = the input has no usable value right now (a numeric field
    // mid-edit). Drop the key rather than storing undefined, so the saved
    // params carry only values the action can actually use.
    const handleParamChange = (key: string, value: string | number | boolean | undefined) => {
        const params = { ...draftAction.params }
        if (value === undefined) {
            delete params[key]
        } else {
            params[key] = value
        }
        onChangeParams(params)
    }

    return (
        <View className="rounded-lg border p-3 gap-2.5 border-border">
            <View className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground">
                    {index + 1}. {action?.label ?? id}
                    <Text className="text-xs text-muted-foreground"> ({pkg})</Text>
                </Text>
                <View className="flex-row items-center gap-1">
                    <Pressable
                        onPress={() => onMove(index - 1)}
                        disabled={index === 0}
                        className={`p-1.5 ${index === 0 ? 'opacity-40' : 'opacity-100'}`}
                        hitSlop={8}
                    >
                        <ArrowUp size={14} color={mutedColor} />
                    </Pressable>
                    <Pressable
                        onPress={() => onMove(index + 1)}
                        disabled={index === total - 1}
                        className={`p-1.5 ${index === total - 1 ? 'opacity-40' : 'opacity-100'}`}
                        hitSlop={8}
                    >
                        <ArrowDown size={14} color={mutedColor} />
                    </Pressable>
                    <Pressable onPress={onRemove} className="p-1.5" hitSlop={8}>
                        <Trash2 size={14} color={mutedColor} />
                    </Pressable>
                </View>
            </View>

            {(action?.params ?? []).map(param => (
                <ActionParamRow
                    key={param.key}
                    param={param}
                    trigger={trigger}
                    value={draftAction.params[param.key]}
                    onChange={v => handleParamChange(param.key, v)}
                />
            ))}
        </View>
    )
}

export function ActionsCard({
    triggerRef,
    actionRows,
    catalog,
    onAdd,
    onMove,
    onRemove,
    onChangeParams,
}: ActionsCardProps) {
    const trigger = catalog.triggers.find(t => t.ref === triggerRef)

    return (
        <RuleCard title="THEN" isDisabled={!trigger} disabledHint="Choose a trigger first">
            {actionRows.map(({ key, action }, index) => (
                <ActionEntry
                    key={key}
                    index={index}
                    total={actionRows.length}
                    draftAction={action}
                    catalog={catalog}
                    trigger={trigger}
                    onChangeParams={params => onChangeParams(index, params)}
                    onMove={to => onMove(index, to)}
                    onRemove={() => onRemove(index)}
                />
            ))}

            <AddActionMenu
                catalog={catalog}
                trigger={trigger}
                onSelect={action => onAdd(action.ref)}
            />
        </RuleCard>
    )
}
