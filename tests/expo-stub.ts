// Stub for `expo` in unit tests.
// Since SDK 58 most expo-* modules (expo-haptics, expo-document-picker,
// expo-crypto, expo-application, expo-web-browser, …) import their helpers
// from `expo` instead of `expo-modules-core`. The real entry first installs
// the winter runtime (Expo.fx), which loads files a bare Node test environment
// cannot resolve. `expo` only re-exports these names from expo-modules-core,
// so the stub re-exports the same names without the runtime.
export {
    CodedError,
    createPermissionHook,
    createSnapshotFriendlyRef,
    EventEmitter,
    NativeModule,
    PermissionStatus,
    Platform,
    registerWebModule,
    reloadAppAsync,
    requireNativeModule,
    requireNativeViewManager as requireNativeView,
    requireOptionalNativeModule,
    SharedObject,
    SharedRef,
    UnavailabilityError,
    useReleasingSharedObject,
    uuid,
} from 'expo-modules-core'

// Unit tests never run inside Expo Go.
export function isRunningInExpoGo() {
    return false
}

export function getExpoGoProjectConfig() {
    return null
}

export function registerRootComponent() {}

export function disableErrorHandling() {}
