// Vitest stub for react-native-drax, which imports gesture-handler and
// worklets native setup that cannot load under Node. Inert pass-through
// containers are enough for tests that import a screen holding a
// SortableList but do not drag.
'use strict'

const React = require('react')

const passThrough = ({ children }) => React.createElement(React.Fragment, null, children)

module.exports = {
    DraxHandle: passThrough,
    SortableContainer: passThrough,
    SortableItem: passThrough,
    useSortableList: ({ data }) => ({
        data,
        stableKeyExtractor: (_item, index) => String(index),
    }),
}
