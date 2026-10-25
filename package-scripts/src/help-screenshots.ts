import type { Page } from '@playwright/test'

export interface Shot {
    name: string
    setup: (page: Page) => Promise<void>
    target?: string
}

export type ScreenshotPlan = Record<string, Shot[]>

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function parseTopicFlag(args: string[]): { topic?: string; rest: string[] } {
    const rest: string[] = []
    let topic: string | undefined
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--topic') {
            const value = args[i + 1]
            if (!value || value.startsWith('--')) throw new Error('--topic needs a topic id')
            topic = value
            i++
        } else if (arg.startsWith('--topic=')) {
            topic = arg.slice('--topic='.length)
        } else {
            rest.push(arg)
        }
    }
    return topic ? { topic, rest } : { rest }
}

export function planFiles(plan: ScreenshotPlan, topic?: string) {
    const known = Object.keys(plan)
    if (topic && !known.includes(topic)) {
        throw new Error(`Unknown topic "${topic}". Known topics: ${known.join(', ')}`)
    }
    const seen = new Set<string>()
    const files: { topicId: string; shot: Shot; light: string; dark: string }[] = []
    for (const topicId of known) {
        const shots = plan[topicId]
        if (shots.length === 0) throw new Error(`Topic "${topicId}" has no shots`)
        for (const shot of shots) {
            if (!NAME.test(shot.name)) throw new Error(`Invalid shot name "${shot.name}"`)
            if (!shot.name.startsWith(`${topicId}-`)) {
                throw new Error(`Shot "${shot.name}" must start with "${topicId}-"`)
            }
            if (seen.has(shot.name)) throw new Error(`Duplicate shot name "${shot.name}"`)
            seen.add(shot.name)
            if (topic && topicId !== topic) continue
            files.push({
                topicId,
                shot,
                light: `images/${shot.name}.png`,
                dark: `images/${shot.name}.dark.png`,
            })
        }
    }
    return files
}
