import { describe, expect, it } from 'vitest'
import { collectionTopic, liveViewOptions } from './change-signal'

// The server's topic format (core/server/changesignal, Topic): the two
// sides must agree byte for byte, or a live view never hears its signal.
describe('change-signal topics', () => {
    it('names a collection topic as the server does', () => {
        expect(collectionTopic('zoo_animals')).toBe('collection/zoo_animals')
    })

    it('keeps a view live on its own topic', () => {
        expect(liveViewOptions('zoo_fed')).toEqual({ liveTopics: ['collection/zoo_fed'] })
    })
})
