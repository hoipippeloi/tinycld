import { describe, expect, it } from 'vitest'
import { type NavRoute, type NavState, urlFromState } from '../../lib/use-url'

// Navigation states in the shape expo-router builds them: the root slot, the
// app layout, the package's tab route, then the package's own navigators.
function appState(packageRoute: NavRoute): NavState {
    return {
        index: 0,
        routes: [
            {
                name: '__root',
                state: {
                    index: 0,
                    routes: [
                        {
                            name: 'a/(app)',
                            params: { screen: 'mail', params: { screen: 'index', params: {} } },
                            state: { index: 0, routes: [packageRoute] },
                        },
                    ],
                },
            },
        ],
    }
}

// A card opened by a link: expo-router writes every URL param onto every
// route of the path (populateParams).
const linkedCardParams = {
    boardSlug: 'PL',
    card: 'PL-1',
    screen: '[card]',
    params: { boardSlug: 'PL', card: 'PL-1' },
}

function boardRoute(leaf: NavRoute): NavRoute {
    return {
        name: 'boards',
        params: { boardSlug: 'PL', card: 'PL-1', screen: '[boardSlug]', params: linkedCardParams },
        state: {
            index: 0,
            routes: [
                {
                    name: '[boardSlug]',
                    params: linkedCardParams,
                    state: { index: 0, routes: [leaf] },
                },
            ],
        },
    }
}

describe('urlFromState', () => {
    it('reads a card opened by a link', () => {
        const state = appState(
            boardRoute({ name: '[card]', params: { boardSlug: 'PL', card: 'PL-1' } })
        )
        expect(urlFromState(state)).toEqual({
            pathname: '/a/boards/PL/PL-1',
            params: { boardSlug: 'PL', card: 'PL-1' },
            href: '/a/boards/PL/PL-1',
        })
    })

    // The case expo-router gets wrong: the card is closed, but the board's
    // parent routes still carry the params of the link that opened it.
    it('drops the param of a closed card that its parent routes still carry', () => {
        const state = appState(boardRoute({ name: 'index', params: { boardSlug: 'PL' } }))
        expect(urlFromState(state)).toEqual({
            pathname: '/a/boards/PL',
            params: { boardSlug: 'PL' },
            href: '/a/boards/PL',
        })
    })

    it('puts query params in the href, not the pathname', () => {
        const state = appState({ name: 'mail', params: { folder: 'sent', label: 'a b' } })
        expect(urlFromState(state)).toEqual({
            pathname: '/a/mail',
            params: { folder: 'sent', label: 'a b' },
            href: '/a/mail?folder=sent&label=a+b',
        })
    })

    it('follows a navigator that has not rendered yet', () => {
        const state = appState({
            name: 'boards',
            params: {
                boardSlug: 'PL',
                card: 'PL-1',
                screen: '[boardSlug]',
                params: linkedCardParams,
            },
        })
        expect(urlFromState(state).pathname).toBe('/a/boards/PL/PL-1')
        expect(urlFromState(state).params).toEqual({ boardSlug: 'PL', card: 'PL-1' })
    })

    it('reads catch-all segments and the not-found route', () => {
        const drive = appState({ name: 'drive/[...path]', params: { path: ['docs', 'q3'] } })
        expect(urlFromState(drive).pathname).toBe('/a/drive/docs/q3')
        expect(urlFromState({ routes: [{ name: '+not-found', path: '/nope' }] }).pathname).toBe(
            '/nope'
        )
    })
})
