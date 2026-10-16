// react-native-web ships no type declarations. Only the pinned-sections test
// imports it directly (for the real, sticky-capable ScrollView), so declare
// just that export, typed as React Native's own.
declare module 'react-native-web' {
    export const ScrollView: typeof import('react-native').ScrollView
}
