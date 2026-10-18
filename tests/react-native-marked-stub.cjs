// Vitest stub for react-native-marked.
// Its entry ships Flow-style `typeof` syntax and native setup that Vite/Rollup
// cannot parse, and core's MarkdownRenderer extends its Renderer at module
// load. An inert Renderer base and a component that renders nothing are
// enough: unit tests exercise component wiring, not markdown output.
'use strict'

class Renderer {
    constructor(options) {
        this.options = options
    }
}

function Markdown() {
    return null
}

module.exports = { __esModule: true, default: Markdown, Renderer }
