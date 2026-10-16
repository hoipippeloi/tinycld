// Vitest stub for react-native-drax, which pulls in react-native-gesture-handler
// and reanimated from node_modules (past the aliases). Under test the sortable
// list renders its rows in order and drag does nothing.
'use strict'

const React = require('react')

const passthrough = ({ children }) => React.createElement(React.Fragment, null, children)

function useSortableList({ data, keyExtractor }) {
    return { data, stableKeyExtractor: keyExtractor }
}

module.exports = {
    __esModule: true,
    DraxHandle: passthrough,
    SortableContainer: passthrough,
    SortableItem: passthrough,
    useSortableList,
}
