import type { Schema } from '@tinycld/core/types/pbSchema'
import type { CreateCollectionOptions } from 'pbtsdb'

// Topics of the server's data-free change signals (core/server/changesignal).
// A message on a topic says only that the collection, or a collection a view
// reads, changed; the subscriber fetches what it shows again.

/** The change-signal topic of a collection: `collection/<name>`. */
export function collectionTopic(name: string): string {
    return `collection/${name}`
}

/**
 * Options that keep a view collection live. The server signals the view's
 * own topic when a collection its SQL reads changes, as declared by the
 * package's `changesignal.RegisterView`.
 *
 * @example
 * newCollection('zoo_fed', { ...onDemand, ...liveViewOptions('zoo_fed') })
 */
export function liveViewOptions(
    view: string
): Pick<CreateCollectionOptions<Schema, keyof Schema>, 'liveTopics'> {
    return { liveTopics: [collectionTopic(view)] }
}
