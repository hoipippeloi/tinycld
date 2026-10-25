import { describe, expect, it } from 'vitest'
import { parseTopicFlag, planFiles, type ScreenshotPlan } from '../src/help-screenshots'

const noop = async () => {}
const plan: ScreenshotPlan = {
    'alpha-topic': [
        { name: 'alpha-topic-1', setup: noop },
        { name: 'alpha-topic-2', setup: noop },
    ],
    'beta-topic': [{ name: 'beta-topic-1', setup: noop }],
}

describe('parseTopicFlag', () => {
    it('extracts --topic and leaves the rest', () => {
        expect(parseTopicFlag(['--topic', 'alpha-topic', '--x'])).toEqual({
            topic: 'alpha-topic',
            rest: ['--x'],
        })
    })
    it('accepts --topic=id', () => {
        expect(parseTopicFlag(['--topic=beta-topic'])).toEqual({ topic: 'beta-topic', rest: [] })
    })
    it('returns no topic when absent', () => {
        expect(parseTopicFlag([])).toEqual({ rest: [] })
    })
    it('throws when --topic has no value', () => {
        expect(() => parseTopicFlag(['--topic'])).toThrow(/--topic needs a topic id/)
    })
})

describe('planFiles', () => {
    it('lists light and dark files for every shot', () => {
        const files = planFiles(plan)
        expect(files.map(f => f.light)).toEqual([
            'images/alpha-topic-1.png',
            'images/alpha-topic-2.png',
            'images/beta-topic-1.png',
        ])
        expect(files[0].dark).toBe('images/alpha-topic-1.dark.png')
    })
    it('narrows to one topic', () => {
        expect(planFiles(plan, 'beta-topic')).toHaveLength(1)
    })
    it('fails for an unknown topic and names the known ones', () => {
        expect(() => planFiles(plan, 'nope')).toThrow(
            /Unknown topic "nope".*alpha-topic.*beta-topic/
        )
    })
    it('fails for a topic with no shots', () => {
        expect(() => planFiles({ empty: [] })).toThrow(/Topic "empty" has no shots/)
    })
    it('fails for a name that is not a plain token', () => {
        expect(() => planFiles({ t: [{ name: 't-../x', setup: noop }] })).toThrow(
            /Invalid shot name/
        )
    })
    it('fails when the name does not start with the topic id', () => {
        expect(() => planFiles({ t: [{ name: 'other-1', setup: noop }] })).toThrow(
            /must start with "t-"/
        )
    })
    it('fails on duplicate names across topics', () => {
        expect(() =>
            planFiles({
                a: [{ name: 'a-1-1', setup: noop }],
                'a-1': [{ name: 'a-1-1', setup: noop }],
            })
        ).toThrow(/Duplicate shot name "a-1-1"/)
    })
})
