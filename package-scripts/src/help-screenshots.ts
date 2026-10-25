import fs from 'node:fs'
import path from 'node:path'
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
            if (!topic) throw new Error('--topic needs a topic id')
        } else {
            rest.push(arg)
        }
    }
    return topic ? { topic, rest } : { rest }
}

// `--topic` may come before or after the `--` separator; both forms select a topic.
export function resolveTopic(
    ownArgs: string[],
    passthrough: string[]
): { topic?: string; passthrough: string[] } {
    const own = parseTopicFlag(ownArgs)
    const after = parseTopicFlag(passthrough)
    const topic = own.topic ?? after.topic
    return topic ? { topic, passthrough: after.rest } : { passthrough: after.rest }
}

// Shared by the config (so a bad plan fails before the web servers start) and the spec.
export async function loadPlan(member: string): Promise<ScreenshotPlan> {
    const file = path.join(member, 'help', 'screenshots.ts')
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist`)
    return (await import(file)).default
}

export function planFiles(plan: ScreenshotPlan, topic?: string) {
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
        throw new Error('help/screenshots.ts default export must be an object of topic id to shots')
    }
    const known = Object.keys(plan)
    if (topic && !known.includes(topic)) {
        throw new Error(`Unknown topic "${topic}". Known topics: ${known.join(', ')}`)
    }
    const seen = new Set<string>()
    const files: { topicId: string; shot: Shot; light: string; dark: string }[] = []
    for (const topicId of known) {
        const shots = plan[topicId]
        if (!Array.isArray(shots)) throw new Error(`Topic "${topicId}" must be an array of shots`)
        if (shots.length === 0) throw new Error(`Topic "${topicId}" has no shots`)
        for (const shot of shots) {
            if (typeof shot.setup !== 'function') {
                throw new Error(`Shot "${shot.name}" needs a setup function`)
            }
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
