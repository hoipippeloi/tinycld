import type { CatalogField } from '@tinycld/core/lib/automation/api'
import {
    addCondition,
    removeCondition,
    removeGroup,
    setGroupMatch,
    updateCondition,
} from '@tinycld/core/lib/automation/condition-helpers'
import type { RuleDraft } from '@tinycld/core/lib/automation/draft'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Plus, Trash2 } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { ConditionRow } from './ConditionRow'
import { MatchPillPair } from './MatchPillPair'

export interface ConditionGroupBoxProps {
    conditions: RuleDraft['conditions']
    fields: CatalogField[]
    // The group to RENDER, passed rather than re-derived from groupIndex: the
    // parent keys these on the builder-local uid, so a re-derive by index reads
    // a different group than the one React reconciled this element to whenever
    // groups are added or removed above it.
    group: RuleDraft['conditions']['groups'][number]
    // The group's position, which is how the mutation helpers address it.
    groupIndex: number
    onChangeConditions: (conditions: RuleDraft['conditions']) => void
}

export function ConditionGroupBox({
    conditions,
    fields,
    group,
    groupIndex,
    onChangeConditions,
}: ConditionGroupBoxProps) {
    const mutedColor = useThemeColor('muted-foreground')

    return (
        <View className="rounded-lg border p-3 gap-2.5 border-border">
            <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                    <Text className="text-xs text-muted-foreground">Match</Text>
                    <MatchPillPair
                        match={group.match}
                        onSelect={match =>
                            onChangeConditions(setGroupMatch(conditions, groupIndex, match))
                        }
                    />
                    <Text className="text-xs text-muted-foreground">conditions</Text>
                </View>
                <Pressable
                    onPress={() => onChangeConditions(removeGroup(conditions, groupIndex))}
                    className="p-1.5"
                    hitSlop={8}
                >
                    <Trash2 size={14} color={mutedColor} />
                </Pressable>
            </View>

            {group.conditions.map((condition, conditionIndex) => (
                <ConditionRow
                    // Keyed on the builder-local uid (condition-helpers.ts's
                    // ensureUids/addCondition), not conditionIndex — an index
                    // key would let React reconcile a deleted row's open Menu
                    // (Menu owns isOpen internally) onto whichever row now
                    // occupies that index.
                    key={condition.uid}
                    condition={condition}
                    fields={fields}
                    onChange={patch =>
                        onChangeConditions(
                            updateCondition(conditions, groupIndex, conditionIndex, patch)
                        )
                    }
                    onRemove={() =>
                        onChangeConditions(removeCondition(conditions, groupIndex, conditionIndex))
                    }
                />
            ))}

            <Pressable
                onPress={() => onChangeConditions(addCondition(conditions, groupIndex))}
                className="self-start flex-row items-center gap-1 py-1"
            >
                <Plus size={13} color={mutedColor} />
                <Text className="text-xs text-muted-foreground">add condition</Text>
            </Pressable>
        </View>
    )
}
